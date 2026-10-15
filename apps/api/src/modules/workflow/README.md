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
