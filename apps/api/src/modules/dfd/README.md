# `dfd`

Documento de Formalização da Demanda (DEC-040, nível 4). Dono de `Dfd` — o cabeçalho tipado 1:1 do
`Document` do tipo `DFD` (Decreto 10.947/2022, art. 8º). Primeiro documento tipado do produto: o
padrão aqui é o que ETP, TR, pesquisa de preços e mapa de riscos repetem.

## US-014 — Elaborar DFD em wizard (DFD-01/02/03)

- **Rotas** (`presentation/dfd.controller.ts`): DFD-01 `GET /processes/{id}/dfds`, DFD-02
  `POST /processes/{id}/dfds` (Idem.), DFD-03 `GET /dfds/{id}`. Contratos em
  `packages/validation/src/dfd/` (`dfdSchema`, `dfdMetaSchema` — com `template`, `dfdCreateSchema`,
  `dfdStepIssues`, `evaluateDfdCompleteness`).
- **id do DFD = id do documento** (CHECK `dfds_id_is_document`): a SCR-007
  (`/processos/{id}/dfd/{dfdId}`) e o painel de documentos usam o mesmo identificador; seções, itens
  (DOC-06/07), validação (DOC-08) e prévia (DOC-20) são os endpoints genéricos do `document`.
- **Criação** (`CreateDfdCommand`, uma transação): `DocumentFacade.createStructuredIn` (template
  publicado, `DFD_CREATE` + custódia POL-01 + POL-02, singular 409, número, `document.create`,
  `DocumentCreated` `document.created.dfd`, timeline) → `createDfdFromProcess` (RN-DFD-05, valores do
  processo por `ProcessFacade.dfdDefaultsIn`, data de hoje no fuso do tenant) → `dfds`. Falha em
  qualquer ponto desfaz tudo, inclusive o número (`test/tenant-leak/dfds.spec.ts`). Log
  `dfd.created`, métrica `dfd_created_total`, `dfd.create_failed` pela base do comando.
- **Completude** (`DfdDocumentValidator`, registrado no `onModuleInit`): a função pura
  `evaluateDfdCompleteness` (a MESMA do wizard), alimentada com os itens do documento, o vínculo do
  responsável, o setor e os anexos em verificação. `typedSummary` (cartão do painel) e
  `snapshotParts` (cabeçalho + itens no snapshot/PDF). O contribuidor `DfdRuleContextContributor`
  publica `documents.DFD.isComplete` para o `workflow` com a mesma avaliação (`isCompleteIn`).
- **POL-09**: a estimativa sai `null` + `estimatedValueMasked: true` em processo sigiloso para quem
  não vê o orçamento (`DocumentFacade.typedDocumentIn` → `canViewConfidentialBudget`).
- **Testes**: `domain/dfd.spec.ts`, `presentation/dfd.routes.spec.ts` (8 categorias do Gherkin +
  FA-02/05/06/09/10/11) e `test/tenant-leak/dfds.spec.ts` (PostgreSQL).
- **Fora desta story**: conclusão/aprovação = US-016/017; duplicação = US-018.

## US-015 — Autosave do cabeçalho (DFD-04)

- **Rota** `PATCH /dfds/{id}` (`PatchDfdHeaderCommand`), `If-Match: "<version>"`, corpo
  `dfdPatchSchema` (estrito: `processId`/`documentId` → `NOT_ALLOWED`) com APENAS os campos
  alterados — inclusive `wizardStep`/`completedSteps` (retomada, RN-DFD-34). Patch sem mudança =
  200 sem versão nova.
- **Ordem:** janela da auditoria dos textos (Redis, antes da transação, só se o patch tem texto) →
  DFD do tenant (404 `DFD_NOT_FOUND`) → `DocumentFacade.editableTypedDocumentIn` (linha do documento
  travada; POL-02 de edição — 403 `NOT_PROCESS_CUSTODIAN`; 409 processo/documento; 422 etapa) →
  `If-Match` (412 `VERSION_CONFLICT` com `meta.current` = o DFD atual + `updatedBy`, para o merge do
  cliente — RN-DFD-28) → POL-09 da estimativa (403 `reasonCode = POL-09`) → `dfdPatchIssues`
  (`packages/validation`: regras nos campos enviados + os pares que os CHECKs de `dfds` conferem
  juntos no cabeçalho mesclado) + setor da secretaria e responsável ativo → `applyDfdPatch` (domínio)
  → `DfdRepository.update` condicionado à versão.
- **Auditoria** `document.draft_update` (`target = HEADER`): campos de dados imediatos com `changes`
  (estimativa `[MASKED]` em processo sigiloso; textos como hash + tamanho); só textos (`objectSummary`,
  `pcaJustification`) → coalescido pela janela; só o passo do wizard → sem auditoria. Log
  `info dfd.header_saved` (`changedFields`, `version`). Sem evento de domínio.
- **Front (SCR-007):** `apps/web/src/features/dfd/use-dfd-autosave.ts` sobre o `useAutosave` de
  `@contrataflow/ui` (seções → DOC-05, cabeçalho → DFD-04).

## US-018 — Duplicar DFD (DFD-05)

- **Rota** `POST /dfds/{id}/duplicate` (`DuplicateDfdCommand`, Idem.), corpo `dfdDuplicateSchema`
  (`targetType` `NEW_PROCESS` | `EXISTING_PROCESS`, `targetProcessId` só no segundo). Uma transação.
- **Novo processo** (RN-DFD-74): `ProcessFacade.createProcessForDfdIn` — a mecânica da duplicação de
  processo (US-011: `duplicateDraft` + `CreateProcessCommand.createIn`, com `PROCESS_CREATE` no setor
  → 403) e os itens ativos da origem renumerados (`duplicateItems`); devolve o mapa item de origem →
  item novo.
- **Processo existente** (RN-DFD-73/75): o documento tipado confere `DFD_CREATE`, custódia, status,
  etapa e DFD ativo único (índice decide a corrida → 409); `ProcessFacade.cloneItemsForDfdIn` trava o
  processo, clona os itens do DFD como `ProcessItem` a partir do próximo número (limite de 1.000 → 422)
  e grava `process.items_update` + `ProcessItemsChanged`. Processo inexistente/de outro tenant/não
  visível → 422 `REFERENCE_NOT_FOUND` em `targetProcessId`.
- **Documento**: `DfdDocumentCreator` (comum ao DFD-02) → `createStructuredIn` com `source`
  (`sourceDocumentId` + seções copiadas por chave sobre o template publicado — `draftContentFromSource`);
  itens do DFD remapeados via `DocumentFacade.copyItemsIn`; cabeçalho por `duplicateDfd` (setor e
  responsável do destino, data de hoje; previsão passada e estimativa de orçamento sigiloso não
  migram). Auditoria `document.duplicate`; eventos `DocumentCreated` (+ `ProcessCreated` /
  `ProcessItemsChanged`). Log `dfd.duplicated`, métrica `dfd_duplicated_total`.
- **Front**: `apps/web/src/features/dfd-duplicate` (SCR-113 "Duplicar apenas o DFD"), botão no
  cabeçalho da SCR-007 e na linha do DFD do painel de documentos (só com `DFD_CREATE`).
- **Testes**: `domain/dfd.spec.ts`, `presentation/dfd-duplicate.routes.spec.ts` (8 categorias) e
  `test/tenant-leak/dfd-duplicate.spec.ts` (PostgreSQL: atomicidade, concorrência, tenant).
