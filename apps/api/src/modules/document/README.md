# `document`

Tipos, templates, documentos, versões imutáveis, renderização e itens de documento (DEC-040).

## Ciclo de vida do documento (US-065 · DEC-017/018)

- **Rotas** (`DocumentController`): DOC-03 `GET /documents/{id}` (SCR-105; o painel do processo é o
  DOC-01 — US-062), DOC-04 `PATCH` (título/responsável do rascunho), DOC-08 `GET …/validation`,
  DOC-09 `POST …/submit`, DOC-10 `POST …/finalize`, DOC-12 `POST …/reopen`, DOC-13
  `POST …/cancel`, DOC-14 `DELETE`. Mutações exigem `If-Match` (412 com `currentVersion`); DOC-09/10
  aceitam `Idempotency-Key`. Respostas `{ data: Document, meta: { allowedActions } }` + `ETag`.
- **Autorização:** a permissão de edição/submissão depende do TIPO (`DOCUMENT_*` nos livres/externos;
  `DFD_*`, `ETP_*`, `TERM_*`, `RISK_*`, `PRICE_RESEARCH_*` nos tipados — `domain/document-permissions.ts`),
  então DOC-04/09/10/14 são `@ImplicitAccess` + `@Policy('POL-02')` e o caso de uso confere tudo
  sobre o processo do documento (`AccessFacade.assertCanOnProcess` — perfil com escopo ∪
  participação, MFA, `access.denied`). DOC-12 declara `DOCUMENT_REOPEN` + POL-11; DOC-13,
  `DOCUMENT_CANCEL` + POL-01 (custódia — `NOT_PROCESS_CUSTODIAN`). Documento de processo não
  visível, excluído ou de outro tenant → 404 `NOT_FOUND`.
- **Ordem das checagens:** 404 → 403 (permissão, custódia/participação) → 409
  `INVALID_PROCESS_STATUS` / 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` → 412 `If-Match` → 409
  `INVALID_STATE` (transição do domínio) → 422 `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED`.

### Padrão `DocumentLifecycleService` (reúso pelos módulos tipados)

`application/document-lifecycle.service.ts` concentra as peças; os comandos
(`application/document.commands.ts`, base `TransactionalCommandHandler` com nome
`document.transition`) e as transições acionadas por outros módulos
(`application/document-approval.transitions.ts`) as combinam, sempre numa ÚNICA transação:

1. `load(tx, id)` — documento + tipo + versão de template + processo (porta
   `DocumentProcessContextRegistry`, implementada por `process`) e a visibilidade (DEC-024).
2. `actorOf(context)` + `authorizePol02`/`authorizeReopen`/`authorizeCancel`.
3. `assertVersion(context, ifMatch)`.
4. Transição pura do domínio (`domain/document.ts` — a tabela de DEC-018) via `transition(() => …)`:
   recusa vira 409 `INVALID_STATE`/`DOCUMENT_NOT_EDITABLE`. Nunca se muda `status` fora dela
   (RN-DOC-41).
5. `evaluate(tx, context)` — completude genérica (`domain/document-completeness.ts`) + o
   `DocumentValidator` do módulo tipado, num único `violations[]`; `gateCompleteness` decide.
6. `save(tx, next, expectedVersion)` — `UPDATE … WHERE version = esperada` ANTES de criar a versão:
   o perdedor de duas transições simultâneas recebe 412 sem gravar nada (FKs de versão/aprovação
   são `DEFERRABLE`).
7. `createVersion(…)` — snapshot (entities.md §5.3.2) com `contentHash` = SHA-256 do JSON canônico
   (RFC 8785); `UPLOADED` congela o arquivo da versão corrente.
8. Auditoria (`document.*`, texto livre só como hash + tamanho) → outbox (`Document*`, routing key
   `document.<fato>.<tipo>`; a timeline projeta no mesmo `tx`).

`meta.allowedActions` vem de `allowedDocumentActions` (função pura do domínio — a mesma para o
painel da US-062 e para o visualizador): `UPDATE`, `FINALIZE` | `SUBMIT` (conforme
`requiresApproval`), `REOPEN`, `CANCEL`, `DELETE`. A retirada (`WITHDRAW`, DOC-11) entra com a
US-053 — a transição `withdrawSubmission` já existe no domínio.

### Porta `DocumentValidator` (módulos tipados: DFD, ETP, TR, mapa de riscos, pesquisa de preços)

Declarada em `application/document.ports.ts`; o módulo tipado (nível 4, importa `DocumentModule`)
implementa e registra no `onModuleInit`:

```ts
@Injectable()
export class DfdDocumentValidator implements DocumentValidator {
  readonly module = 'DFD';
  // RN-DOC-51 b: códigos com o prefixo do módulo, no formato único de violations[] (api.md §2.1.2).
  async validate(tx, { document, type, template }) { return [/* DFD_ITEMS_REQUIRED … */]; }
  // RN-DOC-52: resumo serializável para DocumentFinalized (só STRUCTURED); null = omitido.
  async typedSummary(tx, subject) { return { itemsCount: 3 }; }
  // Cabeçalho tipado e coleções congelados no snapshot; também liga a checagem dos campos
  // obrigatórios do cabeçalho (`fieldConfig[k].required` do template).
  async snapshotParts(tx, subject) { return { header: { … }, collections: { items: [ … ] } }; }
}
// no módulo dfd: onModuleInit() { this.documents.registerValidator(this.validator); }
```

Tudo roda no `tx` do caso de uso (RLS), sem I/O externo. Um validador por `SystemDocumentModule`
(`DocumentValidatorRegistry` recusa o segundo). Tipo estruturado sem validador usa só as regras
genéricas — a ausência de registro nunca falha a ação.

### Criação, singularidade e aprovações

- `DocumentFacade.createIn(tx, input)` (`DocumentCreationService`) é o ÚNICO ponto de criação:
  tipo ativo, processo do tenant, `singletonKey = documentTypeId` quando
  `allowMultiplePerProcess = false` (409 `DOCUMENT_ALREADY_EXISTS`; o índice único parcial
  `documents_singleton_key` decide a corrida), número por último (DEC-028), `document.create` e
  `DocumentCreated`. Autorização de criação e etapa são de quem chama (DOC-02 na US-063/064).
- Submissão avulsa (DOC-09): a `Approval` (`subjectType = DOCUMENT`) é aberta no mesmo `tx` pela
  porta `DocumentApprovalRegistry` (`#shared/document/document-approval.ts`), implementada pelo
  módulo `approval` (resolução do aprovador pela `approvalPolicy`; titular da unidade, evento
  `ApprovalRequested` e concessão `APPROVER` ficam para a US-051).
- Tramitação/aprovação (US-047/051/052): `DocumentFacade.enterApprovalStageIn` (RN-DOC-44) e
  `applyApprovalDecisionIn` (RN-DOC-45), no `tx` de quem chama.
- **Banco:** migração `20261016130000_documents` — `documents`, `document_versions` (só INSERT,
  gatilho `document_versions_append_only`), `approvals`, `approval_documents`; RLS; FKs compostas
  por tenant; cancelado é final (gatilho); exclusão só lógica. Testes com PostgreSQL:
  `test/tenant-leak/documents.spec.ts`.

## Documento tipado: `createStructuredIn` + validador registrado (US-014 · padrão para ETP/TR/…)

O módulo tipado (nível 4) cria o seu documento e o cabeçalho no MESMO `tx`:

```ts
// no CreateXCommand do módulo dono (TransactionalCommandHandler):
const created = await this.documents.createStructuredIn(tx, {
  processId, systemModule: 'ETP', templateId,            // null = template padrão do tipo
  titleOf: (process) => `ETP — ${process.title}`,
  messages: { templateInvalid: '…', notCustodian: '…' },
  idempotencyKey,
});
await this.etps.insert(tx, createEtpFrom(created.document, …)); // cabeçalho tipado
```

- `StructuredDocumentCreator` (`application/structured-document.creator.ts`), na ordem: processo
  visível (404) → template ativo do tipo com versão publicada (422 em `templateId`) →
  `authorizeCreateAsCustodian` (permissão de criação do tipo + custódia POL-01 — 403
  `NOT_PROCESS_CUSTODIAN`; participação não cria — + processo editável 409 + tipo na etapa 422) →
  `initialDraftContent` (todas as seções da versão com `revision = 1`, `defaultContent` com as
  variáveis resolvidas, estado derivado do conteúdo) → `DocumentCreationService` (singular 409,
  número, `document.create`, `DocumentCreated`, timeline). Devolve documento, tipo, versão de
  template, processo e `allowedActions`.
- **Completude**: o módulo registra o seu `DocumentValidator` (`documents.registerValidator`); o
  DOC-08, finalizar/submeter e `DocumentFacade.isCompleteIn` (o `RuleContext` da tramitação) usam o
  mesmo registro. Regras específicas como função pura em `packages/validation` (ex.:
  `evaluateDfdCompleteness`), reaproveitada pelo checklist do front. Specs do `document` que
  simulam o módulo tipado usam `DocumentValidatorRegistry.override` (o real já está registrado).
- **Leitura**: `typedDocumentIn` (documento visível + ações + POL-09, `null` = o 404 do módulo),
  `documentItemsIn`, `documentStatesIn`.

### Itens de documento (DOC-06/07 · `document_items`)

- `DocumentItemsController`: DOC-06 `GET /documents/{id}/items` (`ETag` = versão do documento) e
  DOC-07 `PUT` (substituição completa, `If-Match` obrigatório). Comando
  `ReplaceDocumentItemsCommand`: `FOR UPDATE` no documento → 404 → POL-02 de edição do tipo → 412 →
  409 `DOCUMENT_NOT_EDITABLE` → itens do processo `FOR SHARE` pela porta
  `#shared/process/process-item-catalog.ts` (implementada por `process`) + unidade
  (`CatalogFacade.unitsOf` — `metadata.allowsDecimal`) → `planDocumentItems` (domínio puro: V-09/V-10,
  diff) → gravação → `version + 1` do documento → `document.items_update` (sem evento). Log
  `document.items_saved`.
- `DocumentItemUsageReader` registra os documentos na porta `ProcessItemUsageRegistry`: item
  referenciado → 409 `ITEM_IN_USE` na exclusão (US-006) e `references` no PRC-13.

## Autosave de seção — DOC-05 (US-015 · RN-DFD-23..36 · DEC-055/056/017)

- **Rota** (`presentation/document-sections.controller.ts`): `PUT /documents/{id}/sections/{sectionKey}`
  com `If-Match: "s<revision>"` (revisão da SEÇÃO — `"7"` nunca casa: 412), classe de limite
  `autosave` (60/min por usuário + documento). Corpo `documentSectionSaveSchema` (`notApplicable` OU
  `state`; `overwrittenRevision` só em "Manter a minha versão"); resposta `{ sectionKey, state,
revision, updatedAt, updatedBy, draftRevision }` + `ETag: "s<revision>"`. Genérico: ETP, TR e
  documentos livres usam a mesma rota.
- **Caso de uso** (`SaveDocumentSectionCommand`): janela da auditoria coalescida aberta ANTES da
  transação (`DRAFT_AUDIT_COALESCER`) → documento visível (404) → permissão de EDIÇÃO do tipo +
  POL-02 (sem custódia/participação = 403 `NOT_PROCESS_CUSTODIAN` com `access.denied` POL-02 —
  `authorizePol02(…, notCustodian)`) → chave na versão do template (422 `SECTION_NOT_IN_TEMPLATE`) →
  conteúdo (`domain/section-draft.ts`: 413 > 1 MB, 422 `RICH_TEXT_INVALID`, `TOO_LONG`,
  justificativa de "não se aplica") → editável (409 `DOCUMENT_NOT_EDITABLE` com `meta.status` e
  `meta.statusSince`) → reenvio idêntico = 200 no-op (RN-DFD-36, mesmo com `If-Match` antigo) →
  revisão (412 `SECTION_REVISION_CONFLICT` com `meta.current`: conteúdo, revisão, autor e horário) →
  `DocumentRepository.saveSectionDraft`: UM `UPDATE … jsonb_set(…)` condicionado a status
  `DRAFT`/`RETURNED`, `deleted_at IS NULL` e à revisão da seção (sem `FOR UPDATE`); zero linhas →
  releitura para distinguir 404/409/412. `Document.version` NÃO muda (RN-DFD-26 — exceção registrada
  em entities.md §1.1) e nenhuma versão é criada.
- **Auditoria** `document.draft_update`: coalescida (`target = SECTION:<CHAVE>`, `fromRevision`,
  `toRevision`, `sizeBytesBefore/After`, `contentHash`, `windowMinutes`) ou imediata em "Manter a
  minha versão" (`conflictResolution = KEEP_MINE`, `overwrittenRevision`, `overwrittenAuthorId`).
  Texto nunca vai para log nem auditoria.
- **Logs/métricas:** `debug document.section_saved`, `info document.section_conflict`,
  `error document.section_save_failed` (base do comando); `document_section_saves_total{result}`,
  `document_section_conflicts_total`.
- **Cabeçalho tipado pelo módulo dono:** `DocumentFacade.editableTypedDocumentIn` (trava a linha,
  404 = `null`, POL-02 de edição com `NOT_PROCESS_CUSTODIAN`, 409 não editável) — o DFD-04 usa;
  ETP-04/TRM-04 seguem o mesmo padrão.
- **Testes:** `domain/section-draft.spec.ts`, `dfd/presentation/dfd-autosave.routes.spec.ts` (8
  categorias do Gherkin) e `test/tenant-leak/dfd-autosave.spec.ts` (PostgreSQL: 50 gravações
  paralelas, `jsonb_set`, RLS).

## Documento externo — upload com versões (US-064 · RN-DOC-31..40 · DEC-017/136)

- **Rotas:** DOC-02 `POST /processes/{id}/documents` (`ProcessDocumentsController`,
  `CreateProcessDocumentCommand` — Idem.; `DOCUMENT_CREATE` + POL-02) e DOC-19
  `POST /documents/{id}/upload-version` (`DocumentController`, `UploadDocumentVersionCommand` — IM +
  Idem., classe de limite `upload`; `DOCUMENT_UPDATE` + POL-02). Comandos em
  `application/uploaded-document.commands.ts`; contratos `documentCreateSchema` e
  `documentUploadVersionSchema` em `@contrataflow/validation`.
- **DOC-02:** processo visível (404 `NOT_FOUND`) → tipo do tenant `UPLOADED` ativo (422
  `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) → `DocumentLifecycleService.authorizeCreate`
  (permissão de criação do tipo cobrindo o processo + custódia/participação + processo editável +
  tipo na etapa) → responsável ativo → a fábrica única (`DocumentCreationService`). Nasce `DRAFT`
  sem versão. **`FREE_TEXT` ainda responde 422**: a US-063 acrescenta o ramo (template publicado +
  seções) neste mesmo comando.
- **DOC-19:** `FOR UPDATE` → `load` (404) → `authorizePol02(…, 'edit')` → tipo `UPLOADED` (422
  `NOT_ALLOWED`) → `If-Match` (412) → `recordManualVersion` (409 `DOCUMENT_NOT_EDITABLE`) → anexo pela
  porta `AttachmentFileRegistry` (`#shared/files/attachment-files.ts`, implementada por `files`) e a
  regra pura `domain/uploaded-version.ts` (`uploadedVersionFile`: anexo do PRÓPRIO documento — senão
  422 `REFERENCE_NOT_FOUND` em `attachmentId`, inclusive de outro tenant —, `AVAILABLE` com hash —
  senão 409 `ATTACHMENT_NOT_AVAILABLE` + `warn document.upload_version_not_available`) →
  `createVersion(reason UPLOAD, file)` (`content` nulo, `contentHash` = SHA-256 do arquivo) →
  `recordDocumentVersion` (auditoria com `attachmentId`/`sha256`; `DocumentVersionCreated`).
  Dois envios simultâneos com o mesmo `If-Match`: a trava serializa, um vence e o outro recebe 412
  (recarrega o `ETag` e vira a versão seguinte). Métrica `cf_document_upload_versions_total{result}`.
- **Prévia:** ATT-05 do `files` (URL assinada ≤ 300 s, auditada) do anexo da versão corrente; PDF,
  PNG e JPEG inline (`INLINE_PREVIEW_EXTENSIONS`), demais só download. DOCX → PDF é P2 (RN-DOC-37).
- **Testes:** `domain/uploaded-version.spec.ts`, `presentation/uploaded-documents.routes.spec.ts`
  (8 categorias do Gherkin + FA-01..05) e `test/tenant-leak/uploaded-documents.spec.ts` (PostgreSQL).

## Painel de documentos do processo (US-062 · RN-DOC-13..20)

- **Rota:** DOC-01 `GET /processes/{id}/documents` (`ProcessDocumentsController`,
  `@RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })`) →
  `GetProcessDocumentsHandler` (`application/process-documents.query.ts`). Contratos em
  `packages/validation/src/document/process-documents.ts`.
- **Leitura composta sem N+1:** tipos do cache de DTY-01 (`DocumentTypeFacade.listAll`, ANTES da
  transação — no cache frio ele abre a própria leitura), uma consulta `listByProcess` (inclui
  cancelados), nomes dos responsáveis numa consulta, ator (`actorOf`) memoizado por
  `systemModule`, permissões de criação por código distinto. `summary` = `typedSummary` do
  `DocumentValidator` (só tipados com validador — ≤ 5 singulares por processo).
- **Regras puras:** `domain/process-documents-panel.ts` (`panelTypes`, `sortPanelDocuments`,
  `filterPanelDocuments`) e `createPermissionOf` (`domain/document-permissions.ts`). POL-09 do resumo
  via `maskConfidentialRecord`.
- **Logs/métricas:** `info document_panel.loaded` (`processId`, `documentCount`, `durationMs`),
  `error document_panel.load_failed` (`errorCode`, `correlationId`), histograma
  `cf_document_panel_duration_ms{result}`; o warn do cache de tipos passou a ser
  `document_type.cache_unavailable`. Nunca loga título.
- **Testes:** `domain/process-documents-panel.spec.ts`, `presentation/process-documents.routes.spec.ts`
  (8 categorias do Gherkin) e `test/tenant-leak/process-documents.spec.ts` (PostgreSQL).

## Versões imutáveis e comparação (US-066 · RN-DOC-56..62)

- **Rotas:** DOC-15 `GET /documents/{id}/versions` (desc, sem snapshot), DOC-16
  `POST /documents/{id}/versions` (Idem., sem `If-Match`; `@ImplicitAccess` + POL-02 como DOC-04),
  DOC-17 `GET /document-versions/{versionId}` (`DocumentVersionController`), DOC-18
  `GET /documents/{id}/versions/compare?from=&to=`. Contratos em
  `packages/validation/src/document/document-version.ts`.
- **"Salvar versão"** (`SaveDocumentVersionCommand`, nome `document.version_save`): trava a linha
  do documento (`DocumentRepository.lockForUpdate` — `FOR UPDATE`; em memória espera o `tx` dono
  terminar) → `load` (404) → `authorizePol02(…, 'edit')` → `UPLOADED` = 422 `NOT_ALLOWED` →
  `recordManualVersion` (409 `DOCUMENT_NOT_EDITABLE`) → `save` (bumpa a `version`) →
  `createVersion(reason MANUAL, changeSummary)` → `recordDocumentVersion` (auditoria + evento, o
  mesmo helper das transições). O resumo nunca vai para log, auditoria nem evento.
- **POL-09** (`DocumentLifecycleService.confidentialMasker`): mascara quando o processo é sigiloso
  agora OU era na versão e o usuário não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo
  (sem o MFA exigido não conta) nem a custódia. `domain/confidential-snapshot.ts` lista os campos
  monetários (`MONETARY_SNAPSHOT_FIELDS`) e os troca por `null` + `<campo>Masked: true` no cabeçalho
  e nas coleções, inclusive aninhadas. Módulo tipado com campo monetário novo: inclua-o na lista.
- **Comparador** (`domain/document-version-comparator.ts`, `diffDocumentVersions`): função pura;
  igualdade por JSON canônico; `MASKED` nunca revela se o valor mudou; chave natural das coleções
  em `NATURAL_KEYS` (`items` → `processItemId`, demais → `id`).
- **Testes:** `domain/document-version-comparator.spec.ts`, `presentation/document-versions.routes.spec.ts`
  (8 categorias do Gherkin) e `test/tenant-leak/document-versions.spec.ts` (PostgreSQL: `FOR UPDATE`,
  gatilho só-INSERT, RLS, outbox `PENDING`).

## PDFs dos documentos (US-067 · RN-DOC-63..70 · ADR-007)

- **Rotas** (`presentation/rendition.controller.ts`): DOC-20 `POST /documents/{id}/preview`, DOC-21
  `POST /document-versions/{versionId}/renditions` (`{ kind: CONTENT|APPROVAL_STAMPED, approvalId? }`),
  DOC-22 `GET /document-renditions/{id}`, DOC-23 `GET …/download`. `PROCESS_VIEW` na rota; o caso de
  uso confere o documento (DEC-024 — 404). Classe de limite `export` (20/min). DOC-21 responde 202
  (nova) ou 200 (equivalente reaproveitada) via `WithHttpStatus` do `EnvelopeInterceptor`.
- **Pedido** (`application/rendition.commands.ts`): uma transação — `DocumentRendition` `PENDING`
  - auditoria `document.render_request` (`reused`); depois do commit, `document-render` com
    `jobId = renditionId` (prévia prioridade 1; versão 5). Fila fora → fica `PENDING` (reconciliador;
    um DOC-21 equivalente também reenfileira). Prévia nunca reaproveita (cada clique gera a sua).
- **POL-09 decidido no pedido:** `masked = true` quando o processo é (ou era, na versão) sigiloso e
  quem pede não pode ver o orçamento (`RenditionAccess.maskRequired`). O worker só aplica
  `maskConfidentialSnapshot`. Equivalência de FA-01 inclui `masked` (índices únicos parciais por
  versão × `masked`, sem `FAILED`); DOC-23 de PDF completo de conteúdo sigiloso sem POL-09 → 403.
- **Worker** (`RenderDocumentJob` → `RenderDocumentProcessor`, padrão do `ScanFileJob`): trava
  condicional por `version` (`canClaim`: `PENDING`, tentativa anterior ou trava vencida de 60 s) →
  snapshot da versão ou `DocumentLifecycleService.snapshotOf` do rascunho → `buildRenditionHtml`
  (`domain/rendition-html.ts`: `packages/editor` `richTextToHtml`, variáveis do layout, marca d’água
  na prévia, hash da versão no rodapé) → Gotenberg (`infrastructure/gotenberg.client.ts`) →
  `inspectPdf` (SHA-256/tamanho/páginas) → `StorageService.putObject` (bucket `renditions`,
  `cf-retention`) → `READY` + `DocumentRenditionReady`. Erros (`RenderDeferredError` sem consumir
  tentativa com o disjuntor ABERTO; `RenderRetryableError` transitório; `RenderFailedError` depois de
  gravar `FAILED` + `DocumentRenditionFailed` — permanente ou última tentativa). Disjuntor:
  `PdfRendererCircuit` = `DependencyCircuit` do shared kernel (o mesmo do ClamAV).
- **Worker app:** `RenditionRequesterLookup` (destinatário de `DOCUMENT_RENDER_FAILED`) e a tarefa
  diária `previews-expire`. Como o `file-scan`, o consumidor real da fila entra quando o worker
  carregar os módulos da API (traduzir `consumesAttempt`/`permanent` e a concorrência 2/tenant).
- **Banco:** migração `20261017120000_document_renditions` (gatilho `document_renditions_guard`,
  CHECKs de forma/`READY` completo/chave no prefixo do tenant, RLS, sem DELETE). Testes:
  `domain/document-rendition.spec.ts`, `domain/rendition-html.spec.ts`, `domain/pdf-inspection.spec.ts`,
  `infrastructure/gotenberg.client.spec.ts`, `presentation/renditions.routes.spec.ts` (8 categorias
  do Gherkin) e `test/tenant-leak/document-renditions.spec.ts` (PostgreSQL).

## Conteúdo gerado por IA e revisão humana (US-122 · RN-AI-53..58)

- **Proveniência por seção** (`DraftContent.sections[k].ai` — `domain/section-ai-provenance.ts`):
  `withAiApplied` (DOC-26 — US-117..US-121: proveniência nova e pendente, zera a revisão), `aiAfterSave`
  (DOC-05 — US-015: editar mantém; `EMPTY`/`NOT_APPLICABLE` limpa) e `reviewAiSections` (DOC-27). O
  `document` não importa `ai` (D9): só lê o `draftContent`.
- **DOC-26** `POST /documents/{id}/ai-apply` (`ApplyAiContentCommand` · US-117): `@Idempotent` +
  `If-Match` (versão do documento). Linha travada → permissão de edição do tipo + POL-02 → proposta
  pela porta `AiSuggestionSource` (404/403 `AI_GENERATION_NOT_OWNED`/409) → 412 →
  `applyAiSections` (`domain/ai-content-apply.ts`: só `draftContent`; chave fora da proposta →
  422 `NOT_ALLOWED`; `FILLED`/`NOT_APPLICABLE` sem `confirmReplaceFilled` → 422
  `CONDITIONAL_REQUIRED`; conteúdo fora do schema/limite → 409 `AI_GENERATION_NOT_APPLICABLE`) →
  rascunho completo substituindo texto: versão `SYSTEM` "Antes de aplicar conteúdo gerado por IA"
  com o snapshot ANTERIOR (`DocumentVersionCreated`) → `markApplied` → `ai.content_apply` (sem texto)
  → `AiContentApplied` (timeline `AI_CONTENT_APPLIED`) — tudo num `tx`. Uma aplicação por geração.
  `DocumentAiTargets` (AI-01): documento inexistente/de outro tenant agora é 404 `NOT_FOUND`; de
  outro processo do tenant continua 422 `REFERENCE_NOT_FOUND`.
- **DOC-27** `POST /documents/{id}/ai-review` (`ReviewAiContentCommand`): linha travada → permissão de
  EDIÇÃO do tipo + POL-02 (`AI_GENERATE` não é exigida) → chaves do documento (`NOT_ALLOWED`) →
  `expectedRevisions` das seções pendentes (412 `VERSION_CONFLICT` + `meta.current`) → `reviewedAt/By`,
  `revision + 1`, `draftRevision + 1`, `version + 1` → `ai.content_review` → `AiContentReviewed`
  (`document.ai_content_reviewed.<tipo>`, timeline `AI_CONTENT_REVIEWED`). Nada pendente = 200 sem
  gravar (idempotente, sem evento nem auditoria). Lote de 2+ seções exige `confirmAll: true`.
- **Completude** (`document-completeness.ts`): `SECTION_AI_REVIEW_PENDING` e
  `SECTION_PLACEHOLDER_PENDING` (`params.count`) bloqueantes e independentes, em todo tipo e também
  nas seções do rascunho fora do template → DOC-09/10 respondem `DOCUMENT_INCOMPLETE`.
- **Prévia** (`rendition-html.ts`): nota "Conteúdo gerado por IA — revisão pendente" no topo da seção
  pendente (só `PREVIEW`) e `toConfirm` destacado (`<mark class="cf-to-confirm">`, em
  `@contrataflow/editor`). O nó `toConfirm` é validado em `@contrataflow/validation` (`rich-text.ts`).

## Biblioteca padrão de templates (US-110 · RN-TPL-28..36)

- **Fixture:** `domain/template-library.ts` (`TEMPLATE_LIBRARY`, versão `TEMPLATE_LIBRARY_VERSION`;
  `2026.10.2` = DFD com títulos, base legal e `minChars` de RN-DFD-07 — US-014) —
  um modelo por tipo semeado com template (DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH, DESPACHO,
  OFICIO, NOTA_TECNICA, AUTORIZACAO, DECLARACAO; `DOCUMENTO_EXTERNO` não recebe). Para evoluir a
  biblioteca num release: edite a fixture, suba `TEMPLATE_LIBRARY_VERSION` e registre no changelog
  os tipos alterados — tenants existentes NÃO recebem a mudança (a adoção é manual: TPL-06 → TPL-08
  → TPL-10, RN-TPL-35/36).
- **Validação (V-01):** `loadTemplateLibrary` confere estrutura, `sectionDefinitionSchema`,
  `layoutDefinitionSchema`, cobertura exata dos tipos e o `TemplateContentValidator` completo
  (`TEMPLATE_INVALID`). Roda em `template-library.spec.ts` (bloqueia o build) e no seeder antes de
  qualquer escrita.
- **Seeder `document.templateLibrary`** (`application/template-library.seeder.ts`, depende de
  `document.systemTypes`): uma `TenantTransaction` por tipo — template `isSystem = true` + v1
  publicada pela mesma `publishTemplateVersion` do editor (`contentHash` RFC 8785) + `defaultTemplateId`
  do tipo (só se ainda nulo). Idempotente pelo template de sistema/nome reservado do tipo; sem
  auditoria por item nem evento (integra `tenant.provision`). Testes trocam a fixture pelo token
  `TEMPLATE_LIBRARY`.
