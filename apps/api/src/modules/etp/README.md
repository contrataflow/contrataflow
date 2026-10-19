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
- **Fora desta story**: leitura/edição (ETP-03/04, US-020/022/023), alternativas (US-021), validador
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
