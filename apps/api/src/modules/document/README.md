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

## Biblioteca padrão de templates (US-110 · RN-TPL-28..36)

- **Fixture:** `domain/template-library.ts` (`TEMPLATE_LIBRARY`, versão `TEMPLATE_LIBRARY_VERSION`) —
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
