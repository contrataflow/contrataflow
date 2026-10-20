# `etp`

Estudo Técnico Preliminar e alternativas (DEC-040, nível 4). Dono de `Etp` — o cabeçalho tipado 1:1
do `Document` do tipo `ETP` (Lei 14.133/2021, art. 18, §1º). Segue o padrão de documento tipado do
DFD (`dfd/README.md`).

## US-019 — Criar ETP a partir de template com importação do DFD (ETP-01/02)

- **Rotas** (`presentation/etp.controller.ts`): ETP-01 `GET /processes/{id}/etps` (0 ou 1 ativo +
  cancelados; `meta.importableDfd` = o DFD elegível para o cartão "Importar dados do DFD") e ETP-02
  `POST /processes/{id}/etps` (Idem.). Contratos em `packages/validation/src/etp/`
  (`etpCreateSchema`, `etpSchema`, `etpSummarySchema`, `etpListMetaSchema`, `ETP_MESSAGES`).
- **id do ETP = id do documento** (CHECK `etps_id_is_document`): SCR-008
  (`/processos/{id}/etp/{etpId}`), seções (DOC-05), itens (DOC-06/07) e versões usam o mesmo id.
- **Criação** (`CreateEtpCommand`, uma transação — RN-ETP-09): `DocumentFacade.importableDfdIn`
  (leitura) → `createStructuredIn` com `allowCollaborators` (RN-ETP-07: custódia OU participação
  `COLLABORATOR`/`CONSULTANT`), `beforeCreate` com o 422 `NOT_ALLOWED` em `importFromDfd` (V-04 —
  depois da autorização), `sectionContents` (`NEED_DESCRIPTION`/`PCA_ALIGNMENT` `FILLED`) e
  `auditChanges` (`documentTypeCode`, `importedFromDfdVersionId`) → `DocumentFacade.copyItemsIn`
  (mesmo `processItemId` e `quantity` — DEC-019) → `etps`. `INVALID_PROCESS_STATUS` vira 409
  `DOCUMENT_NOT_EDITABLE` (V-03). Evento `DocumentCreated` `document.created.etp` (= `ETPCreated`).
  Log `document.created` (`documentTypeCode`, `importedFromDfd`), métrica `etp_created_total`.
- **Importação** (`domain/etp.ts`, puro): lê o SNAPSHOT da versão de origem do DFD
  (`approvedVersionId`, senão `currentVersionId`) — `header.objectSummary` + seção `JUSTIFICATION`,
  `header.pcaStatus`/`pcaYear`/`pcaItemCode`/`pcaJustification`, `collections.items` —, sem depender
  do módulo `dfd` (mesmo nível).
- **Testes**: `domain/etp.spec.ts`, `presentation/etp.routes.spec.ts` (8 categorias do Gherkin +
  FA-01/03/05, V-03, RN-ETP-07) e `test/tenant-leak/etps.spec.ts` (PostgreSQL: atomicidade com
  falha induzida, concorrência, RLS, FKs).
- **Fora desta story**: leitura/edição (ETP-03/04, US-020/022/023), alternativas (US-021, abaixo), validador
  de completude e `snapshotParts` do ETP (US-023).

## US-020 — Editar seções do ETP com autosave e "não se aplica" justificado (ETP-03 · DOC-05/08)

- **ETP-03** `GET /etps/{id}` (`GetEtpQuery`): `typedDocumentIn` (visibilidade DEC-024 — 404
  `NOT_FOUND` "Documento não encontrado." para inexistente/outro tenant/não visível) → `EtpDetail`
  (`Etp` + conclusão/estimativa com POL-09 — `estimatedTotalValueMasked` — + `draftRevision` e
  `draftContent`) e `meta` (`allowedActions` + seções da versão do template com `render` e
  `allowNarrative`). Contratos `etpDetailSchema`/`etpDetailMetaSchema`/`etpIdParamsSchema`.
- **Seções**: nada novo no servidor — o DOC-05 genérico (US-015) já cobre autosave, revisão por
  seção, "não se aplica" (`notApplicable: true` ou `state: 'NOT_APPLICABLE'`, justificativa ≥ 20 —
  mensagem da US-020 em `DOCUMENT_SECTION_MESSAGES`), `SECTION_NOT_IN_TEMPLATE`, `RICH_TEXT_INVALID`
  e a auditoria coalescida `document.draft_update`; ETP_UPDATE vem de `domain/document-permissions.ts`.
- **Regras puras da tela** (`packages/validation/src/etp/etp-sections.ts`): `etpStructuredKind`
  (RN-ETP-12 — `render`, ou a chave `ESTIMATES`/`ALTERNATIVES`/`RISKS` em seção `TEXT`),
  `etpSectionNav`/`etpCompletionSummary` (RN-ETP-13 — estado + pendências do DOC-08) e
  `notApplicableJustificationProblem` (V-04).
- **Web** (`apps/web/src/features/etp/`): `EtpEditor` (SCR-008, dentro do `DocumentView`) com
  `SectionSidebarNav`, `NotApplicableToggle`, quadros somente leitura (`etp-structured-sections.tsx`)
  e `useEtpAutosave` (o `useAutosave` de `@contrataflow/ui`, alvos `SECTION:<CHAVE>`).
- **Testes**: `presentation/etp-sections.routes.spec.ts` (8 categorias do Gherkin + FA-02/05,
  V-01/V-06), `test/tenant-leak/etp-sections.spec.ts` (PostgreSQL) e
  `apps/web/src/features/etp/etp-editor.test.tsx`.

## US-021 — Gerenciar alternativas de solução (ETP-05..09)

- **Rotas** (`presentation/etp-alternative.controller.ts`): ETP-05 `GET /etps/{id}/alternatives`
  (`meta.canManage`, `recommendedAlternativeId`, `estimatedCostMasked`), ETP-06 `POST` idem, ETP-07
  `PATCH`/ETP-08 `DELETE` `/etp-alternatives/{alternativeId}` e ETP-09 `POST .../decide` (os três
  com `If-Match`). Contratos em `packages/validation/src/etp/etp-alternatives.ts` (schemas,
  `ETP_ALTERNATIVE_MESSAGES`, `alternativesComparison` — RN-ETP-23 — e
  `decisionJustificationProblem` — RN-ETP-19) e o evento em `etp/events.ts`.
- **Guarda** (`application/etp-alternative.support.ts` · `EtpAlternativeGate`): POL-02 estendida às
  coleções tipadas pela fachada do `document` (`assertTypedCollectionWritableIn` com `ETP` — trava o
  documento ETP no `tx`; decisões concorrentes se enfileiram) + o ETP precisa ser o ativo do processo
  (cancelado = 409 `DOCUMENT_NOT_EDITABLE`); POL-09 por `typedDocumentIn` (quem não vê o custo também
  não o envia — 403).
- **Domínio** (`domain/etp-alternative.ts`, puro): criação/patch/diff, unicidade de nome sem caixa,
  `planDecision` (RN-ETP-19..21 — substituição com a antiga de volta a `UNDER_ANALYSIS`, gravada antes
  da nova por causa do índice único parcial), `canDeleteEtpAlternative` (RN-ETP-22) e
  `setRecommendedAlternative` (o cabeçalho `Etp`, versão + 1).
- **Efeitos**: auditoria `etp.alternative_create/update/delete/decide` (textos como hash + tamanho,
  custo como `"[sigiloso]"`) e `EtpAlternativeRecommended` (timeline `ETP_ALTERNATIVE_RECOMMENDED`,
  nome congelado pela fonte `ETP_ALTERNATIVE` — `EtpFacade.alternativeNames`). Todos os comandos se
  chamam `etp.alternative_command` (span e o log `etp.alternative_command_failed`); `info`
  `etp.alternative_decided` e `warn` `etp.alternative_recommend_race` (unicidade violada no banco).
- **Banco**: `20261019090000_etp_alternatives` (tabela, índices únicos parciais, CHECK da
  justificativa, FK composta de `etps.recommended_alternative_id`, RLS).
- **Testes**: `domain/etp-alternative.spec.ts`, `presentation/etp-alternative.routes.spec.ts` (8
  categorias do Gherkin + FA-01..05, V-01..V-09) e `test/tenant-leak/etp-alternatives.spec.ts`
  (PostgreSQL: índices, CHECK, concorrência, outbox PENDING, RLS). Web:
  `apps/web/src/features/etp/etp-alternatives-section.tsx` (+ `.test.tsx`).

## US-022 — Estimar quantidades e vincular valor à pesquisa de preços (ETP-04 · DOC-06/07)

- **Itens** (DOC-07 genérico, `document`): a linha do ETP ganhou `calculationMemo` (RN-ETP-27 —
  rich text ≤ 1 MB; 413 `PAYLOAD_TOO_LARGE`/422 `RICH_TEXT_INVALID`). Ausente no corpo = mantém a
  gravada (id e `sortOrder` da linha preservados); `null` limpa. Auditoria `document.items_update`
  com a memória como `{ sha256, bytes }`. Comparação da memória por JSON canônico (o `jsonb`
  reordena as chaves).
- **ETP-04** `PATCH /etps/{id}` (`UpdateEtpCommand`, `application/etp-update.command.ts`):
  `editableTypedDocumentIn` (POL-02 + `DRAFT`/`RETURNED`, documento travado) → `If-Match` da versão
  do ETP (412) → POL-09 (403) → `etpEstimateIssues` (422 — `packages/validation/src/etp/etp-estimate.ts`,
  as mesmas regras no painel da SCR-008) → pesquisa pela porta `PriceResearchSummaryRegistry.linkOf`
  do shared kernel (o `etp` não importa o `price-research` — mesmo nível) → `setEtpEstimate` (domínio
  puro; FA-01/02/03) → `updateEstimate` condicional → `document.draft_update`. Sem evento.
- **Sincronização** (RN-ETP-29/31): no worker, `EtpEstimateSynchronizer`
  (`apps/worker/src/events/etp-estimate-synchronizer.ts`), handler leve do `domain-events` em
  `price_research.recalculated`, `document.finalized.price_research` e
  `document.canceled.price_research`, na transação do tenant do evento (os handlers leves recebem
  agora o `InlineHandlerContext` do job). Copia o total atual para os ETPs `DRAFT`/`RETURNED`
  vinculados (idempotente pelo estado: `IS DISTINCT FROM`), desfaz o vínculo no cancelamento e audita
  como `SYSTEM`. Migração `20261019160000_etp_estimate_sync`: só o `GRANT UPDATE` de colunas de `etps`
  ao `cf_worker`.
- **Web** (`apps/web/src/features/etp/etp-estimates-section.tsx`): `ItemsEstimateTable` (quantidade +
  memória por item, "Salvo às", 412 com "Ver diferenças"/"Recarregar") e `EstimatedValuePanel`
  (manual × pesquisa, somente leitura quando vinculado, revalida a cada 5 s, FA-03/04/05).
- **Testes**: `domain/etp.spec.ts`, `presentation/etp-estimates.routes.spec.ts` (8 categorias +
  FA-01..05, V-01..V-08), `test/tenant-leak/etp-estimates.spec.ts` (PostgreSQL),
  `apps/worker/test/tenant-leak/etp-estimate-sync.spec.ts` (reentrega, relay fora, RLS, cancelamento)
  e `apps/web/src/features/etp/etp-estimates-section.test.tsx`.

## US-023 — Validar completude do ETP e concluí-lo (ETP-04 · DOC-08/10)

- **ETP-04** (`UpdateEtpCommand`, `application/etp-update.command.ts`): o corpo aceita também
  `conclusion` (`VIABLE`/`NOT_VIABLE` — `PENDING` = 422) e `parcelingDecision`; corpo só com eles
  dispensa `estimatedValueSource` e POL-09 (`etpPatchTouchesEstimate`). Estimativa e conclusão
  juntas = UMA versão. `setEtpConclusion` (domínio puro) e `etps.updateHeader` (antes
  `updateEstimate`, grava os 5 campos). Auditoria `document.draft_update` com valores anterior/novo e
  `metadata.conclusion/parcelingDecision`; log `etp.conclusion_saved`.
- **Completude** (`packages/validation/src/etp/etp-completeness.ts` · `evaluateEtpCompleteness`):
  RN-ETP-34 (`FIELD_REQUIRED` em `conclusion`/`parcelingDecision`, `ITEMS_REQUIRED`), RN-ETP-35
  (`VIABLE`: `ETP_RECOMMENDED_ALTERNATIVE_REQUIRED` — exatamente 1 `RECOMMENDED` entre as não
  excluídas — e `ETP_ESTIMATED_VALUE_REQUIRED`) e RN-ETP-36 (`NOT_VIABLE`: aviso
  `ETP_NOT_VIABLE_CONCLUSION`). As seções (RN-ETP-33) são as regras genéricas do `document`.
- **`EtpDocumentValidator`** (`application/etp-document.validator.ts`), registrado no `onModuleInit`:
  `validate` (DOC-08 e a revalidação do DOC-10 no mesmo `tx` — FA-03) e `snapshotParts` (cabeçalho
  `etpSnapshotHeader`, itens e alternativas congelados na versão `FINALIZATION`). Sem
  `typedSummary`. Finalização, versão, auditoria `document.finalize` (`warningsAcknowledged`),
  eventos e timeline são o DOC-10 genérico; `warn document.finalize_warning_pending` no aviso não
  reconhecido (genérico, em `document.commands.ts`).
- **Web**: `EtpConclusionFieldset` e `EtpPendingSummary` ("Pendências para concluir") na SCR-008;
  o botão do ciclo de vida vira "Concluir ETP" (rótulos por módulo em `documents.typed.ETP`).
- **Testes**: `domain/etp.spec.ts`, `packages/validation/src/etp/etp-completeness.test.ts`,
  `presentation/etp-conclusion.routes.spec.ts` (8 categorias + FA-03/04, V-03..V-09) e
  `test/tenant-leak/etp-conclusion.spec.ts` (PostgreSQL: snapshot e hash, revalidação atômica,
  outbox PENDING, RLS, concorrência).
