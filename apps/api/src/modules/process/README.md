# `process`

Processo, itens, participantes, etiquetas, runtime da tramitação e visibilidade (DEC-040).

## Painel situacional — ações e checklist (US-041)

- **Rotas:** PRC-08 `GET /processes/{id}/available-actions` e PRC-09 `GET /processes/{id}/checklist`
  (`ProcessActionsController`); `id` malformado → 400 `MALFORMED_REQUEST`; não visível → 404
  `NOT_FOUND` igual ao inexistente. Somente leitura (sem auditoria nem eventos).
- **Visibilidade (DEC-024):** `domain/process-visibility.ts` sobre `isProcessVisible`
  (`#shared/auth/process-access.js`) com o escopo de `PROCESS_VIEW` das permissões efetivas
  (US-097): `TENANT`, órgão do processo, unidades do escopo (subárvore/lotação) contra `ProcessAccess`
  de unidade ou concessão própria. Listagens (US-001+) usam `buildVisibilityPredicate`.
- **Quem consulta:** `ProcessViewerResolver` (permissões efetivas do contexto: escopo, lotações e
  chefias) alimenta a custódia (POL-01/04/05) do motor.
- **Autorização por processo (US-097):** `ProcessRuntimeAccessReader` registrado no
  `ProcessAccessRegistry` — `@RequirePermission(…, { scope: { processParam: 'id' } })` lê o órgão,
  as concessões e as participações (`runtime.access.participations`) do processo.
- **Runtime:** porta `PROCESS_RUNTIME_READER` (`application/ports.ts`) — processo, passagens,
  aprovações de etapa, documentos e concessões num ÚNICO snapshot. Em produção, o
  `ProcessRuntimeLoader` da US-001 (abaixo); testes e modo fake usam `InMemoryProcessRuntimeStore`.

## Painel situacional (US-004)

- **Rotas:** PRC-04 `GET /processes/{id}` (com `meta.allowedActions`), PRC-07 `GET /processes/{id}/summary`
  e PRC-10 `GET /processes/{id}/stages` (`ProcessController`, `@ImplicitAccess`). A visibilidade
  (DEC-024, inclusive concessão `USER` — o aprovador designado chega pelo link) é conferida no
  `ProcessPanelReader.load` sobre o runtime do mesmo `tx`; não visível = 404 `PROCESS_NOT_FOUND`
  sem `access.denied`. `Cache-Control: no-store`.
- **Composição:** `application/process-panel.queries.ts` — agregado + runtime (uma leitura:
  `ProcessRuntimeLoader.fromAggregate`), motor (`getAvailableActions`/`evaluateRules`), documentos
  (`DocumentFacade.listForSummary`) e aprovações (`ApprovalFacade.listPendingForProcess`) numa
  transação `REPEATABLE READ READ ONLY` (`ProcessTransactions.snapshot` — RN-PROC-56). Regras puras
  em `domain/process-summary.ts` (ação primária RN-PROC-49, pendências, prazo alvo, aprovador,
  stepper). POL-09 por processo (`canViewConfidentialBudget`) vale também para o PRC-04.
- **Auditoria:** `ConfidentialViewRecorder` grava `process.confidential_view` 1× por sessão
  (`sessionIdHash`; sem ele, o usuário) e processo, marca no `TenantCache` (12 h), em transação
  própria depois da leitura. Contadores de comentários e participantes ficam 0 até as stories donas
  (US-012/071); as etiquetas do cabeçalho vêm de `TagRepository.forProcesses` (US-007).

## Edição dos dados (US-005)

- **Rota:** PRC-05 `PATCH /processes/{id}` (`ProcessController`, `@RequireIfMatch` → 428 sem
  `If-Match`; `PROCESS_UPDATE` em algum escopo no guard). Corpo `updateProcessSchema` (estrito:
  campo fora da lista → 422 `NOT_ALLOWED`) e evento `ProcessUpdated` (`changedFields` + `version`,
  nunca valores) em `packages/validation/src/process/`.
- **Caso de uso:** `UpdateProcessCommand` — `lockForUpdate` (`SELECT … FOR UPDATE`) → leitura do
  agregado e visibilidade (`ProcessPanelReader.load` → 404) → **no-op primeiro** (RN-PROC-67: PATCH
  idêntico responde 200 mesmo com `If-Match` antigo, sem versão/evento/timeline/auditoria) →
  `If-Match` (412 com `currentVersion` e `meta.current` = DTO + `updatedBy`) → `PROCESS_UPDATE`
  cobrindo o processo → status editável (409) → custódia POL-01 (403 `NOT_PROCESS_CUSTODIAN`,
  auditado) → bloqueio por status (422 `NOT_ALLOWED`) → valor estimado com fonte superior (422
  `BUSINESS_RULE_VIOLATION`) → revalidação parcial → referências alteradas → `PROCESS_CREATE` no
  novo setor → código interno → `updateProcess` (`WHERE version`) → `process.update` → evento.
- **Domínio puro:** `domain/process-update.ts` — `diffProcess` (ChangeSet único para evento,
  auditoria e timeline), `fieldLock` (campo × status + RN-PROC-61), `estimatedValueLockedBy`,
  `revalidationIssues`, `applyProcessChanges`, `isProcessCustodian`.
- **Projeções:** timeline `PROCESS_UPDATED` pelo mapeamento existente (`BUDGET_RESTRICTED` com
  `estimatedValue` de processo sigiloso); `ProcessAccessProjector` também ouve `process.updated` e,
  com secretaria/setor alterados, chama `syncRequestingAccess` (revoga `REQUESTING` antigos com
  `revokedAt`, concede os novos) — a custódia (`CURRENT`/`RESPONSIBLE`) não muda.
- **Motor:** PRC-08 emite `EDIT` ("Editar dados") para quem tem `PROCESS_UPDATE`, desabilitada com
  o motivo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` ou sem custódia.
- **Testes:** `domain/process-update.spec.ts`, `presentation/process-update.routes.spec.ts` e
  `test/tenant-leak/process-update.spec.ts` (PostgreSQL: rollback induzido, `FOR UPDATE` × encaminhamento).

## Itens da contratação (US-006)

- **Rotas:** PRC-13 `GET /processes/{id}/items` (`ETag` = versão do PROCESSO), PRC-14 `POST
/processes/{id}/items` (`@Idempotent`), PRC-17 `POST /processes/{id}/items/reorder` (`If-Match` =
  versão do processo) e PRC-15/16 `PATCH`/`DELETE /process-items/{itemId}` (`If-Match` = versão do
  item) — `ProcessItemsController`. Ids malformados → 400 `MALFORMED_REQUEST`. Contratos e
  `ProcessItemsChanged` em `packages/validation/src/process/process-items.ts`/`events.ts`.
- **Casos de uso:** `application/process-items.commands.ts` (`process.items_change`) sobre a guarda
  `ProcessItemsGate` (`lockForUpdate` do processo → visibilidade → `PROCESS_UPDATE` cobrindo o
  processo → status editável → custódia POL-01; item de outro tenant = 404 `NOT_FOUND`), domínio
  puro em `domain/process-items.ts` (numeração máximo + 1, `resolveLot` = LotNamePolicy, reordenação,
  diff), `touchProcess` (`version + 1` do processo a cada alteração) e `ProcessItemsChangeRecorder`
  (auditoria `process.items_update` com descrição/observações como hash + tamanho e o evento, que
  projeta a timeline `ITEMS_CHANGED` no mesmo `tx`). A renumeração grava em duas fases (negativos →
  definitivos) por causa do índice único parcial de `sequence`.
- **Uso do item (RN-PROC-76/79):** porta `#shared/process/process-item-usage.ts`
  (`ProcessItemUsageRegistry`): os donos de `DocumentItem`/`PriceItem` registram leitores no
  `onModuleInit` (devem validar o item com `FOR SHARE` ao referenciá-lo — a exclusão trava o item com
  `FOR UPDATE`). Sem leitor (até US-014/US-024), nenhum item está em uso.
- **Painel:** `RuleContext.process.itemsCount`/`hasLots` e `counts.items` do PRC-07 vêm de
  `ProcessItemRepository.stats`; PRC-08 emite `MANAGE_ITEMS` ("Gerenciar itens") com o motivo de
  modo leitura.
- **Testes:** `domain/process-items.spec.ts`, `presentation/process-items.routes.spec.ts` e
  `test/tenant-leak/process-items.spec.ts` (PostgreSQL: 20 inclusões paralelas, duas fases, rollback,
  RLS e FK composta).

## Participantes (US-012)

- **Rotas:** PRC-28 `GET /processes/{id}/participants` (`PROCESS_VIEW` cobrindo o processo; `meta`
  `{ canManage, me }`), PRC-29 `POST /processes/{id}/participants` (`@Idempotent`,
  `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo no guard + POL-10 no caso de uso), PRC-30
  `DELETE /process-participants/{participantId}` (corpo opcional; o processo do participante é
  conferido no caso de uso — não visível = 404 `PARTICIPANT_NOT_FOUND`) e PRC-31/32
  `POST`/`DELETE /processes/{id}/follow` (`PROCESS_FOLLOW`) — `ProcessParticipantsController`.
  Contratos e eventos em `packages/validation/src/process/process-participants.ts`/`events.ts`.
- **Domínio puro:** `domain/process-participants.ts` — `grantRefusal` (RN-PROC-126..128: consultor
  só usuário `EXTERNAL` ativo e validade ≤ a do vínculo, sem autoinclusão como Colaborador/
  Consultor, referência inexistente/inativa = 422 sem revelar outro tenant, validade futura),
  `unfollowDecision` (RN-PROC-133), `isParticipationExpired` (RN-PROC-135).
- **Efeitos no mesmo `tx`:** `ProcessParticipantRecorder` — `ProcessAccess` `PARTICIPANT`
  (`source_id` = participante; revogado por `revokeParticipantAccess`), auditoria
  `process.participant_add`/`_remove` (sem nome nem motivo) e o evento (timeline
  `PARTICIPANT_ADDED`/`_REMOVED`; o nome vem da fonte `PROCESS_PARTICIPANT` da timeline).
- **Unicidade:** índices únicos parciais por usuário/unidade ativos; a corrida perdida vira 409
  `PARTICIPANT_ALREADY_EXISTS` (`ParticipantAlreadyActiveError`).
- **Autorização e visibilidade:** o runtime (`accessGrantsOf`) traz as participações não vencidas
  (`participations`, inclusive de unidade — vale para os lotados) e as unidades participantes só
  para visibilidade (`participantDepartmentIds` — nunca no escopo de unidade do perfil). Consultor
  vencido perde a visibilidade antes do job (runtime e `buildVisibilityPredicate`).
- **Expiração:** job `participants-expire` do worker (`apps/worker/src/maintenance/
participants-expire.ts`, tarefa do `tenant-housekeeping`): revoga, `ProcessAccess`, timeline,
  auditoria `SYSTEM` e outbox na transação do tenant.
- **Testes:** `domain/process-participants.spec.ts`, `presentation/process-participants.routes.spec.ts`
  e `test/tenant-leak/process-participants.spec.ts` (PostgreSQL: concorrência no índice único,
  rollback induzido, consultor vencido no predicado SQL, RLS, FK composta e gatilho).

## Sigilo do orçamento estimado (US-013)

- **Rota:** PRC-33 `PUT /processes/{id}/confidentiality` (`ProcessController`, `@RequireIfMatch` →
  428; `PROCESS_SET_CONFIDENTIAL_BUDGET` com `processParam` no guard — não visível = 404
  `PROCESS_NOT_FOUND`, sem a permissão = 403 + `access.denied` com o `reasonCode` da permissão, MFA
  pela POL-14). Corpo `setProcessConfidentialitySchema` (estrito) e evento
  `ProcessConfidentialityChanged` (`{ isBudgetConfidential }`) em `packages/validation/src/process/`.
  O PATCH (PRC-05) nunca muda a flag (RN-PROC-137 — campo fora do schema = 422).
- **Caso de uso:** `SetProcessConfidentialityCommand` — `lockForUpdate` → visibilidade
  (`ProcessPanelReader.load`) → `If-Match` **antes** do no-op (o reenvio com versão antiga = 412 e
  nunca repete o efeito) → flag igual = 200 sem versão/evento/auditoria → `updateProcess` (`version +
1`) → `DocumentFacade.applyBudgetConfidentialityIn` (pesquisa de preços `RESTRICTED` ao ativar,
  padrão do tipo ao desativar; cada documento travado, relido e gravado com `version + 1` — RN-PROC-139)
  → `process.confidentiality_change` → evento (timeline `CONFIDENTIALITY_CHANGED`, `STANDARD`, no mesmo
  `tx`). Sem notificação (RN-PROC-145). A resposta aplica a POL-09 sobre o NOVO estado; valor real
  entregue = `process.confidential_view` (`ConfidentialViewRecorder`, fonte `PRC-33`).
- **Máscara (POL-09):** continua por leitura (`canViewConfidentialBudget` nos presenters/queries de
  processo, itens, lista, painel, documentos e PDFs); esta story só liga/desliga a flag.
- **Testes:** `domain/process-confidentiality.spec.ts`, `presentation/process-confidentiality.routes.spec.ts`
  e `test/tenant-leak/process-confidentiality.spec.ts` (PostgreSQL: cascata, rollback induzido,
  concorrência e RLS).

## Visões salvas e exportação CSV (US-003)

- **Rotas:** PRC-35..38 em `SavedViewsController` (`/saved-views`, `@ImplicitAccess` — escopo e posse
  no caso de uso) e PRC-34 em `ProcessExportController` (`/processes/export`, registrado ANTES do
  `ProcessController` para não cair em `:id`; `PROCESS_EXPORT` no guard, classe de limite `export`).
  Contratos em `packages/validation/src/process/saved-views.ts` (filtros versionados `v: 1`, conversão
  URL ⇄ `filters`, upcaster, colunas) e `process-export.ts` (query, rótulos, `PROCESS_EXPORT_MAX_ROWS`).
- **Visões:** `application/saved-views.commands.ts` sobre `TransactionalCommandHandler`; regras puras em
  `domain/saved-view.ts`. Trava `pg_advisory_xact_lock` por dono e escopo (limite de 20, nome e
  padrão única); índices únicos `lower(name)` e parcial da padrão são a rede de segurança. Compartilhada
  de outro dono = 403 com `access.denied` da visão (`ApiError.auditEntity`); privada de outro = 404.
  Sem auditoria nem evento (preferência pessoal); exclusão física.
- **Exportação:** `ExportProcessesQuery` — trava Redis por usuário (`TenantCache`, TTL 2 min; Redis fora
  = segue sem trava com `warn export.lock_unavailable`), contagem exata antes do 1º byte (422
  `EXPORT_TOO_LARGE` com `meta.totalItems`), e o arquivo por cursor no servidor (`DECLARE … CURSOR` +
  `FETCH 500`) numa transação `READ ONLY` longa (`TenantTransaction.longRead`, 60 s) mantida aberta
  pelo `pullInTransaction` (`#shared/database/transaction-stream.js`) enquanto o socket drena —
  padrão de exportação em _streaming_ reutilizável. Linhas = visibilidade E cobertura do escopo de
  `PROCESS_EXPORT` (`exportCoverageSql`). Apresentação pelo `ProcessListPresenter` (o mesmo de
  PRC-01) e serialização em `domain/process-csv.ts` (BOM, `;`, CRLF, pt-BR, neutralização de fórmulas).
  `process.export` `SUCCESS` é gravado ANTES do último pedaço (sem auditoria, sem arquivo completo);
  falha ou cliente que desiste = `FAILURE` com `reasonCode`.
- **Testes:** `domain/process-csv.spec.ts`, `domain/saved-view.spec.ts`,
  `presentation/saved-views.routes.spec.ts` (8 categorias) e `test/tenant-leak/saved-views.spec.ts`
  (PostgreSQL: cursor em 3 lotes, índices, RLS).

## Etiquetas (US-007)

- **Rotas:** TAG-01 `GET /tags` (`PROCESS_VIEW`; `includeInactive=true` só vale com `TAG_MANAGE`, senão é
  ignorado — RN-PROC-91), TAG-02 `POST /tags` (`@Idempotent`) e TAG-03 `PATCH /tags/{id}` (`If-Match`) —
  `TagsController`, `TAG_MANAGE` + MFA da política do tenant; PRC-18 `PUT /processes/{id}/tags`
  (`ProcessTagsController`, `@RequireIfMatch`, `PROCESS_UPDATE` no guard). Contratos, paleta
  acessível (`TAG_PALETTE`, contraste AA com o texto branco do chip) e limites em
  `packages/validation/src/process/tags.ts` — a mesma regra do formulário.
- **Cadastro:** `tags` nunca é excluída (a aplicação não tem `DELETE`); nome 2–40 único no tenant sem
  diferenciar maiúsculas (índice `lower(name)` → 409 `CONFLICT`), cor `#RRGGBB` da paleta (422
  `INVALID_ENUM`/`INVALID_FORMAT`). Auditoria de configuração `tag.create`/`tag.update`/`tag.deactivate`
  (desativar = `tag.deactivate`); **sem evento e sem tocar a versão dos processos** (RN-PROC-90).
- **Aplicação (PRC-18):** `SetProcessTagsCommand` reaproveita a guarda `ProcessItemsGate.writable`
  com recusas próprias (`GateRefusals`: 409 `INVALID_PROCESS_STATUS` e 403 `NOT_PROCESS_CUSTODIAN`
  com as mensagens das etiquetas). Ordem: trava do processo → autorização (`PROCESS_UPDATE` cobrindo o
  processo → status → custódia) → conjunto (RN-PROC-88: máx. 10, repetição, id inexistente/de outro
  tenant = `REFERENCE_NOT_FOUND`, inativa só se já aplicada) → **diferença** → conjunto idêntico
  responde 200 sem versão/evento/timeline/auditoria (antes do `If-Match`, como o PRC-05) → `If-Match`
  (412) → grava só inserções/remoções de `process_tags`, `touchProcess`, `process.tags_update` e
  `ProcessUpdated` (`changedFields = ["tags"]` → timeline `PROCESS_UPDATED`) na mesma transação.
- **Leitura:** a lista (PRC-01) filtra por `tagId` com `EXISTS` em `process_tags` (índice
  `process_tags_tag_idx`) e traz `tags[{id,name,color,isActive}]` por consulta única por página; o painel
  (PRC-07) traz as etiquetas no cabeçalho; `RuleContext.process.tags` leva os NOMES (ativas e inativas —
  RN-PROC-92). PRC-08 expõe `MANAGE_TAGS` ("Etiquetas").
- **Banco:** migração `20261017170000_tags` (`tags` com `UNIQUE (tenant_id, lower(name))`, checks de
  nome/cor, trigger de tenant imutável, RLS; `process_tags` com PK `(tenant_id, process_id, tag_id)`, FKs
  compostas, `CASCADE` no processo, RLS; grants: `cf_app` sem `DELETE` em `tags` e sem `UPDATE` em
  `process_tags`).
- **Testes:** `domain/tag.spec.ts`, `presentation/tags.routes.spec.ts` (8 categorias, em memória) e
  `test/tenant-leak/process-tags.spec.ts` (PostgreSQL: filtro SQL, índice único sob concorrência, 412 sob
  `FOR UPDATE`, rollback induzido, RLS/FKs entre tenants, sem `DELETE`).

## Encaminhamento (US-047)

- **Rota:** PRC-19 `POST /processes/{id}/forward` (`ProcessController`, `@Idempotent`,
  `@RequireIfMatch` → 428; `PROCESS_FORWARD` em algum escopo no guard). Corpo
  `forwardProcessSchema` e resposta `forwardedProcessSchema` (processo + `movement`, `approval?`,
  `numberAssigned`, `statusFrom`) em `packages/validation/src/process/process-forward.ts`, que também
  versiona `ProcessMovement.documents`/`metadata` (`MovementDocumentRef`, `MovementMetadata` v1) e
  as regras puras compartilhadas com o SCR-103 (`forwardCommentIssues`, `dueDateOverrideIssues`).
- **Caso de uso:** `ForwardProcessCommand` — `lockForUpdate` → visibilidade (404) → `expectedStageId`
  (409 `STAGE_CHANGED`) ANTES do `If-Match` (412) → `PROCESS_FORWARD` cobrindo o processo, status e
  custódia (403 `NOT_PROCESS_CUSTODIAN` auditado) → `WorkflowFacade.evaluateTransition` sobre o estado
  travado (`TRANSITION_NOT_AVAILABLE`/`TRANSITION_BLOCKED` com TODAS as violações/`WARNINGS_NOT_
ACKNOWLEDGED`) → comentário → unidade (`DEPARTMENT_REQUIRED`, unidade inválida = 422, unidade
  configurada inativa = `TRANSITION_NOT_AVAILABLE`) e responsável (`ASSIGNEE_NOT_ELIGIBLE`; candidato
  da política inelegível = fila) → prazo (SLA pelo calendário; sobrescrita) → documentos (padrão =
  alterados na passagem) → destino `APPROVAL`: aprovador (`ApprovalFacade.resolveStageApproverIn`) e
  submissão dos cobertos (`DocumentFacade.enterApprovalStageIn`) → número (autuação, por último) →
  `StageTransitionService` → `ApprovalFacade.requestForStageIn` → `process.number_assign`/
  `ProcessNumberAssigned` → `process.forward`. Regras puras em `domain/process-forward.ts`.
- **Prévias de PRC-08:** `ForwardPreviews` (só no PRC-08): `departmentName`, `dueAtPreview` e
  `approverPreview` (não resolvível = `null` + motivo `APPROVER_UNRESOLVED`). O motor expõe
  `transitionId`, `toStageName` e `toStageType` nas entradas de avanço.
- **Projeções:** `ProcessAccessProjector` ouve `process.stage_changed.*` (CURRENT da origem →
  HISTORICAL quando a unidade muda, CURRENT do destino, RESPONSIBLE) e `approval.requested`
  (`APPROVER`). Timeline pelos mapeamentos existentes (`PROCESS_FORWARDED`, `PROCESS_NUMBER_ASSIGNED`,
  `APPROVAL_REQUESTED`…); `PROCESS_RECEIVED`/`APPROVAL_REQUESTED` pelo worker.
- **Testes:** `domain/process-forward.spec.ts`, `domain/stage-transition.spec.ts`,
  `presentation/process-forward.routes.spec.ts` (8 categorias, em memória — fixtures em
  `test/support/process-forward-fixtures.ts`) e `test/tenant-leak/process-forward.spec.ts`
  (PostgreSQL: falha induzida, 20 simultâneos, RLS, eventos `PENDING`).

## Devolução (US-048)

- **Rota:** PRC-20 `POST /processes/{id}/return` (`ProcessController`, `@Idempotent`,
  `@RequireIfMatch` → 428; `PROCESS_RETURN` em algum escopo no guard). Corpo `returnProcessSchema`
  (`targetStageId` = `WorkflowStage`, `comment` 10–5.000, `dueAt?`, `expectedStageId?`) e resposta
  `returnedProcessSchema` (processo + `movement`, `statusFrom`) em
  `packages/validation/src/process/process-return.ts`.
- **Caso de uso:** `ReturnProcessCommand` — `lockForUpdate` → visibilidade (404) → `expectedStageId`
  (se enviado; 409 `STAGE_CHANGED`) ANTES do `If-Match` (412) → `PROCESS_RETURN` cobrindo o processo,
  status `IN_PROGRESS` (409 — em `AWAITING_APPROVAL` a devolução é a decisão US-052/retirada US-053)
  e custódia (403 `NOT_PROCESS_CUSTODIAN` auditado) → `WorkflowFacade.evaluateReturn` (etapa já
  percorrida E com `RETURN` configurada na etapa atual; senão 422 `TRANSITION_NOT_AVAILABLE`, sem
  revelar etapa de outro tenant) → unidade (`departmentResolution`; `CHOSEN_ON_FORWARD` reaproveita
  a da última passagem) → responsável `PREVIOUS_ASSIGNEE` (`ProcessRepository.previousAssignments`:
  responsabilidade mais recente com pessoa entre as passagens encerradas pela etapa; inelegível ou
  nenhum = fila + `warn return.previous_assignee_not_found`) → prazo (SLA pelo calendário;
  `dueAt` só com `allowDueDateOverride`, senão 422 `DUE_DATE_OVERRIDE_NOT_ALLOWED`) →
  `StageTransitionService` (`action/closeAs/statusTo` RETURN/RETURNED/RETURNED,
  `assignmentType: 'RETURN'`, `documents: []`) → `process.return`. Regras puras em
  `domain/process-return.ts`. Nenhum documento muda de status (POL-11).
- **PRC-08:** cada entrada `RETURN` traz `toStageId`, `toStageName`, `toStageType` e `lastPassedAt`
  (saída da última passagem) para o SCR-104; habilitada só em `IN_PROGRESS` com custódia.
- **Projeções e avisos:** os mesmos do encaminhamento (`PROCESS_RETURNED` na timeline, `ProcessAccess`
  pelo `process.stage_changed.return`); no worker, `PROCESS_RETURNED` e `PROCESS_ASSIGNED`
  (`assignmentType = RETURN`).
- **Testes:** `domain/process-return.spec.ts`, `workflow/domain/workflow-engine-return.spec.ts`,
  `presentation/process-return.routes.spec.ts` (8 categorias, em memória) e
  `test/tenant-leak/process-return.spec.ts` (PostgreSQL: falha induzida, 10 simultâneos, eventos
  `PENDING`, destino de outro tenant).

### Mudança de etapa reutilizável (`StageTransitionService`)

Base de toda tramitação (encaminhar — US-047; devolver — US-048; decidir — US-052; concluir —
US-010). Com o processo JÁ travado (ordem de bloqueio: processo → aprovação → documentos), quem
chama resolve destino, responsável, prazo, status, documentos e a aprovação, autoriza e chama:

```ts
const plan = await this.transitions.apply(tx, {
  transition: {
    process,
    active,
    lastStageSequence,
    lastMovementSequence,
    action: 'RETURN',
    closeAs: 'RETURNED',
    transitionId,
    toWorkflowStageId,
    toDepartmentId,
    toUserId,
    assignedById,
    slaDays,
    slaType,
    dueAt,
    dueDateOverrideReason,
    statusTo,
    comment,
    documents,
    approvalId,
    metadata,
    numbering: null,
    actor,
    now,
    ids,
  },
  cause: 'RETURN',
  statusCause: 'RETURN',
  fromStageKey,
  toStage: { key, type },
  requestedApprovalId: null,
});
```

- Plano puro em `domain/stage-transition.ts` (`planStageTransition`): encerra a passagem
  (`COMPLETED`/`RETURNED`, `exitedViaMovementId`) e a responsabilidade ativas, abre a passagem
  `sequence + 1` com a responsabilidade `STAGE_ENTRY`, registra a tramitação imutável e atualiza
  `current*`, `overdueSince = null` e `version + 1` (e o número, na autuação).
- Grava tudo por `ProcessRepository.recordStageTransition` (`WHERE version` como rede) e publica
  `ProcessStageChanged` (`process.stage_changed.<cause>`), `ProcessStatusChanged` só quando o status
  muda e `ProcessAssigned` (`STAGE_ENTRY`) quando a nova passagem nasce com responsável.
- A auditoria da ação (`process.forward`, `process.return`…) e eventos específicos ficam com quem chama.

## Criação do processo (US-001)

- **Rotas:** PRC-02 `POST /processes` (`ProcessController`, `@Idempotent`, `PROCESS_CREATE` em algum
  escopo no guard), PRC-03 `POST /processes/check-duplicates` e PRC-04 `GET /processes/{id}` (mínimo
  para o painel SCR-006; a US-004 completa). Contratos em `packages/validation/src/process/process.ts`
  (`createProcessSchema`, `processDateIssues`, `processSchema`) e o evento `ProcessCreated`
  (`process/events.ts`).
- **Caso de uso:** `CreateProcessCommand` — referências (órgão, catálogos ativos, secretaria/setor do
  mesmo órgão e na subárvore — RN-PROC-02/16) → escopo do `PROCESS_CREATE` sobre o setor
  (`AccessFacade.assertCanInDepartment` — RN-PROC-03) → código interno e duplicidade (RN-PROC-09/13)
  → `WorkflowFacade.resolveApplicable` + etapa inicial (`publishedDefinitionIn`, no mesmo `tx`) →
  unidade/responsável/prazo da etapa → número (`NumberingFacade`, **por último**: a linha da
  sequência fica travada só pelas gravações) → processo + passagem nº 1 + responsabilidade +
  tramitação `CREATE` → `process.create` → `ProcessCreated`.
- **Projeções síncronas:** `TimelineProjector` (`PROCESS_CREATED`) e `ProcessAccessProjector`
  (`application/process-access.projector.ts`, concessões de permissions.md §5), ambos no `tx` do
  `OutboxWriter`. O payload do evento traz `initialDepartmentId`/`initialResponsibleId` para isso.
- **Runtime:** `ProcessRuntimeLoader` substitui o `PendingProcessRuntimeReader`: agregado, passagens
  e concessões numa ÚNICA instrução SQL (`PrismaProcessRepository.loadAggregate`). No modo em
  memória, `InMemoryProcessRuntimeReader` lê primeiro o `InMemoryProcessRuntimeStore` (testes da
  US-041) e depois os processos criados.
- **Banco:** migração `20261016100000_processes` (FK circular `current_stage_id` DEFERRABLE, FKs
  compostas — secretaria e setor pelo órgão do processo —, `search_vector` gerado com `cf_unaccent`,
  trigram em `code`/`title`, tramitação só INSERT + gatilho, FK da timeline). Testes com PostgreSQL:
  `test/tenant-leak/processes.spec.ts`.

### Padrão de comando transacional (`TransactionalCommandHandler`)

Base em `#shared/commands/transactional-command.js`, para todo caso de uso que muda estado de
negócio. Estenda e implemente:

```ts
@Injectable()
export class ForwardProcessCommand extends TransactionalCommandHandler<Input, Prepared, Output> {
  constructor(@Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions /* , … */) {
    super('process.forward', transactions); // nome do span e do log `process.forward_failed`
  }
  // 1. Fora da transação: configuração e pré-condições baratas (sem escrita).
  protected prepare(input: Input): Promise<Prepared> { … }
  // 2. Numa transação do tenant: referências → autorização por escopo → domínio (puro) →
  //    repositórios → audit.record(tx, …) → outbox.record(tx, Evento.of(…)).
  protected handle(tx: TenantTx, input: Input, prepared: Prepared): Promise<Output> { … }
  // 3. Depois do commit: log de negócio e métricas.
  protected override committed(result: Output, durationMs: number): void { … }
}
```

- Erro em qualquer passo de `handle` desfaz agregado, projeções, auditoria, outbox e sequências.
- Falha inesperada (5xx, banco fora) gera `error <comando>_failed` com `errorCode`, causa e
  `correlationId`; erros de regra (4xx) não são logados como falha. Nunca logue texto livre.
- Leituras de outros módulos dentro de `handle` usam o `tx` recebido (métodos `…In(tx, …)` das
  fachadas): abrir outra transação por requisição esgota o pool sob concorrência.
- Trava de linha (sequência, agregado) o mais tarde possível dentro de `handle`.
