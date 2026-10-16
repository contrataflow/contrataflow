# `workflow`

Definição e motor de workflow: avaliação de transições e regras (DEC-040).

## Definição versionada (US-040)

- **Modelo:** `Workflow` 1:N `WorkflowVersion` (`DRAFT` → `PUBLISHED` → `RETIRED`) 1:N etapas,
  transições e regras (`domain/workflow-definition.ts`). Migração
  `20261015280000_workflow_definitions`: FKs compostas com a versão (transição/regra nunca apontam
  para etapa de outra versão ou tenant), FKs circulares deferíveis (`initial_stage_id`,
  `current_published_version_id`), rascunho único e `START` única por índice parcial.
- **Imutabilidade:** gatilhos `trg_wf_definition_immutable` (etapas, transições e regras só mudam em
  `DRAFT`) e `trg_wf_version_immutable` (fora de `DRAFT` só `PUBLISHED` → `RETIRED`); valem até para
  SQL direto. A aplicação barra antes (409 `WORKFLOW_VERSION_NOT_DRAFT`); se o gatilho disparar, é
  bug (`error workflow.immutability_violation_attempt`).
- **Escrita no rascunho:** `WorkflowDraftEditor` — `WORKFLOW_MANAGE` + MFA, trava a versão
  (`FOR UPDATE`, serializa com a publicação), incrementa `WorkflowVersion.version` (o `ETag` da
  publicação — US-045), deriva `initialStageId` e audita `workflow.update` com `entityType`.
- **Validação:** `WorkflowDefinitionValidator` (puro, todos os `WF_*` numa execução — api.md §2.3);
  catálogos lidos por `WorkflowReferenceService` (unidades, usuários, perfis e, pela porta
  `DocumentTypeCatalog` do shared kernel, os tipos de documento — `document` está no mesmo nível).
- **Publicação:** `WorkflowVersionPublisher` (fachada: `publish`/`publishIn(tx)` para o seeder da
  US-042 e o WF-21 da US-045 — quem chama autoriza). Snapshot canônico (`domain/workflow-snapshot.ts`,
  JCS + SHA-256 de `#shared/integrity/canonical-json.js`) em `definitionSnapshot`/`definitionHash`.
- **Leitura publicada:** `WorkflowFacade.publishedDefinition(versionId)` — cache Redis
  `workflow:def:{versionId}` (24 h, imutável); Redis fora → banco + `warn
workflow.definition_cache_unavailable`. WF-09 de versão publicada usa o snapshot.
- **Regras:** `config` por tipo, caminhos do RuleContext v1 e whitelist JSON Logic em
  `packages/validation/src/workflow` (compartilhados com o editor e o avaliador da US-041).

## Motor de execução (US-041)

- **Fachada:** `WorkflowFacade.getAvailableActions(tx, state, viewer)` (PRC-08) e
  `evaluateRules(tx, state)` (PRC-09) — o MESMO cálculo que os comandos de tramitação (US-047/048)
  devem chamar antes de aceitar uma transição. Também `resolveStageDepartment`/`resolveStageAssignee`
  (RN-WF-30/31) e `registerRuleContextContributor`. Quem chama autoriza.
- **Domínio puro:** `domain/workflow-engine.ts` (regras `STAGE_EXIT` da etapa + `TRANSITION` das saídas
  `FORWARD`/`COMPLETE`; `enabled` ⇔ sem `reasons`; avisos só no checklist; ciclo de vida por status e
  titularidade), `domain/rule-evaluator.ts` (estratégia por `RuleType`, fail-closed, nunca lança;
  whitelist JSON Logic conferida também na execução) e `domain/stage-destination.ts`.
- **Aplicação:** `WorkflowEngineService` lê só o snapshot da versão FIXADA (`publishedDefinition`,
  cache imutável) e monta o RuleContext v1 com o `RuleContextBuilder` (semente do `process` +
  contribuidores registrados; `stage.businessDaysInStage` pelo calendário do `catalog`).
- **Logs:** `info workflow.actions_computed`; `error workflow.rule_evaluation_failed` (com `ruleId`);
  `warn workflow.rule_context_missing_path`; `error workflow.pinned_version_unavailable`/
  `workflow.stage_not_in_version`. Métricas `cf_workflow_engine_duration_ms` e
  `cf_workflow_rule_failures_total`; spans `workflow.available_actions`/`evaluate_rules`.

## Workflow padrão e aplicabilidade (US-042)

- **Seeder `workflow.seedWorkflows`** (`application/default-workflows.seeder.ts`, conteúdo em
  `domain/default-workflows.ts` — DEC-015): `DEFAULT_PREPARATORY` (padrão, prioridade 100, sem
  regra, 7 etapas) e `DIRECT_CONTRACTING_ART72` (prioridade 50, regra
  `process.modalityCode ∈ {DISPENSA, INEXIGIBILIDADE}`, 5 etapas). Um workflow por
  `TenantTransaction`, v1 publicada pela MESMA rotina do editor (`publishIn` — validação, snapshot,
  hash). Depende de `document.systemTypes`, `access.defaultRoles` (perfil `AUTORIDADE_COMPETENTE`,
  lido por `AccessFacade.findRoleByKey`) e `catalog.items`. Idempotente pela chave; corrida entre
  execuções resolvida pelo índice único. `PESQUISA_PRECOS` nasce `CHOSEN_ON_FORWARD` (o tenant novo
  não tem unidade de Compras). Mudou o conteúdo → nova `DEFAULT_WORKFLOWS_VERSION` (o seeder nunca
  sobrescreve: tenants existentes só ganham o que falta).
- **Resolução (WF-06 · RN-WF-39):** `domain/workflow-applicability.ts` (puro) +
  `WorkflowApplicabilityService.resolveIn(tx, process)`, exposto em
  `WorkflowFacade.resolveApplicable` para a criação de processo (US-001). Só caminhos `process.*`;
  regra quebrada não casa (fail-closed, `error workflow.applicability_rule_failed`). Sem cache: lê
  os workflows do tenant a cada chamada (poucas linhas); o prefixo `workflow:applicable` já é
  invalidado pelo worker se um cache vier a existir.
- **Troca do padrão (WF-05 · RN-WF-40..42):** `SetDefaultWorkflowCommand` trava TODOS os workflows
  do tenant e sobe a `version` de todos — duas trocas sobre a mesma leitura dão 200 + 412. O índice
  único parcial `(tenant_id) WHERE is_default` é a rede de segurança. Já padrão → 200 sem efeito.
- **Lista (WF-01):** ordem da aplicabilidade; filtros e ordenações do editor chegam com a US-043.

## Editor de workflow (US-043)

- **Exclusão restritiva (RN-WF-50 · FA-01):** WF-12/WF-15 não removem mais em cascata — etapa com
  transições (origem/destino) ou regras, ou transição com regras → 422 `BUSINESS_RULE_VIOLATION`
  com uma `violation` por item (`itemId`, `params.{kind,key,name}`; puro em
  `domain/workflow-delete-guard.ts`). As FKs `ON DELETE CASCADE` ficam só como rede do banco.
- **"Criar rascunho" (WF-08 · RN-WF-47):** sem `sourceVersionId` exige versão publicada (senão 422
  `BUSINESS_RULE_VIOLATION`/`WORKFLOW_NOT_PUBLISHED`); `sourceVersionId` explícito (inclusive
  aposentada) continua valendo. Segundo rascunho → `warn workflow.draft_conflict`.
- **WF-01:** filtro `status` (`ACTIVE`/`INACTIVE` = `isActive`) além de `q`.
- **Logs:** o `WorkflowDraftEditor` registra `info workflow.stage_saved`/`transition_saved`/
  `rule_saved` (operação CREATE/UPDATE/DELETE) depois do commit e `error workflow.write_failed`
  em falha de infraestrutura (5xx).
- **Front (SCR-034):** `apps/web/src/features/workflows` — `workflow-editor.tsx` (tabela ordenável,
  avisos do grafo, "Criar rascunho"), `stage-properties-panel.tsx` (salva por campo ao perder o
  foco, com os mesmos condicionais da API), `workflow-transitions.tsx` e o modelo puro
  `workflow-editor-model.ts`.
