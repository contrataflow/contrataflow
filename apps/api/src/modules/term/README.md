# `term`

Termo de Referência (DEC-040, nível 4). Dono de `TermOfReference` — o cabeçalho tipado 1:1 do
`Document` do tipo `TR` (Lei 14.133/2021, art. 6º, XXIII). Segue o padrão de documento tipado do
DFD/ETP (`etp/README.md`).

## US-036 — Criar TR e editar suas seções (TRM-01..04 · DOC-05)

- **Rotas** (`presentation/term.controller.ts`): TRM-01 `GET /processes/{id}/terms` (0 ou 1 ativo +
  cancelados; `meta.templates` = modelos publicados do tipo TR, o padrão primeiro, e
  `meta.defaultTitle`), TRM-02 `POST /processes/{id}/terms` (Idem.), TRM-03 `GET /terms/{id}` e
  TRM-04 `PATCH /terms/{id}` (`If-Match: "<version>"`). Contratos em
  `packages/validation/src/term/` (`termCreateSchema`, `termPatchSchema`, `termDetailSchema`,
  `TERM_MESSAGES`, `termCompleteness`…).
- **id do TR = id do documento** (CHECK `terms_of_reference_id_is_document`): SCR-012
  (`/processos/{id}/tr/{termId}`), seções (DOC-05), itens (DOC-06/07) e versões usam o mesmo id.
- **Criação** (`CreateTermCommand`, uma transação): `createStructuredIn` com a CUSTÓDIA (participação
  não cria — RN-TR-02), `templateId`/`title` opcionais, sigilo `RESTRICTED` com orçamento sigiloso
  (RN-TR-09) → `TermOfReference` com o objeto do processo, os padrões válidos do `fieldConfig`
  (RN-TR-06) e, havendo pesquisa `FINALIZED`/`APPROVED` com total, o vínculo `PRICE_RESEARCH`
  (RN-TR-07). Erros traduzidos: 409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingTermId`, 409
  `INVALID_PROCESS_STATUS`, 422 de etapa. Log `term.created`, métrica
  `document_created_total{type="TR"}`.
- **Pesquisa de preços**: `price-research` é do mesmo nível — a leitura vem da porta
  `#shared/price-research/price-research-summary.ts` (`PriceResearchSummaryRegistry`), cujo leitor o
  `price-research` registra no `onModuleInit`.
- **Leitura** (`GetTermQuery`): `typedDocumentIn` (404 `NOT_FOUND` indistinguível) → POL-09 no
  serializador único (`term.presenter.ts`: `estimatedTotalValue = null` +
  `estimatedTotalValueMasked`, total das pesquisas também `null`) → completude pela avaliação do
  DOC-08 (`DocumentFacade.sectionCompletenessIn` — RN-TR-13).
- **Painel "Dados do TR"** (`UpdateTermHeaderCommand`): `editableTypedDocumentIn` (TERM_UPDATE +
  POL-02 com custódia OU participação; 409 `DOCUMENT_NOT_EDITABLE` com a mensagem do TR) → 412 →
  POL-09 (403 para quem não vê o valor) → `estimatedValueIntent` (domínio puro — RN-TR-08) →
  `document.draft_update` imediata (objeto como hash + tamanho; valor mascarado se sigiloso).
- **Seções**: o DOC-05 genérico (US-015). Único ajuste: no TR, seção `REQUIRED` recusa "não se
  aplica" na gravação (422 `NOT_ALLOWED` em `state` — `rejectsNotApplicable` em
  `document/domain/section-draft.ts`).
- **Testes**: `domain/term-of-reference.spec.ts`, `presentation/term.routes.spec.ts` (8 categorias do
  Gherkin) e `test/tenant-leak/terms.spec.ts` (PostgreSQL: atomicidade com falha induzida,
  concorrência, POL-09, RLS, checks e FKs).
- **Fora desta story**: condições contratuais e itens (US-038), validador tipado e conclusão
  (US-039).

## US-037 — Importar dados do ETP para o TR (TRM-05/06)

- **Rotas** (`presentation/term.controller.ts`): TRM-05 `POST /terms/{id}/import-etp/preview` (somente
  leitura) e TRM-06 `POST /terms/{id}/import-etp` (`If-Match: "<version>"` + Idem.). Contratos em
  `packages/validation/src/term/term-import.ts`; evento `TermImportedFromEtp` em `term/events.ts`.
- **Abertura comum** (`application/etp-import.commands.ts` · `TermEtpImportReader`): TR → POL-02 de
  edição (`openEditableTerm`, trava a linha do documento) → TR **relido depois da trava** (a
  aplicação concorrente vencedora já gravou → 412) → ETP do processo (`DocumentFacade.importableEtpIn`
  — rascunho mais recente, versão vigente e itens; 422 `ETP_REQUIRED_FOR_IMPORT`) → cabeçalho do ETP
  pela porta `#shared/etp/etp-header.ts` (`EtpHeaderRegistry`, registrado pelo `etp` — mesmo nível) →
  `planEtpImport` (`domain/etp-import.ts`, puro) com o `importMappings` da versão do template fixada.
- **Token** (`domain/etp-import.ts`): `v1.<claims>.<HMAC>` sem estado, 15 min, com a impressão digital
  (`importFingerprint`) do ETP e do TR lidos na prévia; a chave (`TERM_IMPORT_TOKEN_KEY`) é derivada
  da `BLIND_INDEX_KEY` no `term.module.ts` (sem variável de ambiente nova). A aplicação recalcula:
  vencido/alterado → 410; adulterado ou de outro TR/tenant → 422 em `importToken`.
- **Aplicação** (uma transação): `selectImport` (V-01, NOT_ALLOWED, RN-TR-22) → `applyEtpFields` +
  `recordImport` (valor/origem `ETP`/pesquisa + `importedFromEtp*`, `version + 1`) →
  `DocumentFacade.importIn` (`document/application/document-import.service.ts`: seções `FILLED` com a
  proveniência de IA de entities.md §5.10, upsert de itens por `processItemId`, versão `IMPORT` +
  `DocumentVersionCreated`) → `term.import_etp` (chaves, valor mascarado se sigiloso) →
  `TermImportedFromEtp` (timeline). Itens especificados: `DocumentItemRepository.specifiedProcessItemIds`
  lê as colunas `specification`/`acceptance_criteria` (ainda sem edição — US-038).
- **TRM-03**: `etpChangedSinceImport` = versão vigente do ETP ≠ `importedFromEtpVersionId`.
- **Web**: `apps/web/src/features/term/import-etp-panel.tsx` (painel, campos, itens, confirmação da
  origem do valor e o aviso de defasagem) e `etp-import-model.ts`.
- **Testes**: `domain/etp-import.spec.ts`, `presentation/term-etp-import.routes.spec.ts` (8 categorias
  - FA-02..06) e `test/tenant-leak/term-etp-import.spec.ts` (PostgreSQL: falha induzida na versão
    IMPORT, duas aplicações simultâneas, RLS).

## US-038 — Itens e condições contratuais do TR (TRM-04 · DOC-06/07)

- **Condições** (`UpdateTermHeaderCommand`, o mesmo TRM-04 do painel "Dados do TR"): faixas no
  `termPatchSchema` (`TERM_CONDITION_LIMITS`/`TERM_CONDITION_MESSAGES`); `mergeTermConditions`
  (domínio puro) aplica o corpo sobre o atual — ausente mantém, `null` limpa — e confere o par prazo ×
  tipo de contagem no estado final (`termDeadlineIssue`, compartilhado com a tela); critério de
  julgamento novo pelo `CatalogFacade.find` (ativo, do tipo `JUDGMENT_CRITERION`, do tenant). A
  garantia volta do banco como `Decimal.toString()` (`"5"`) e o corpo é normalizado igual
  (`normalizePercent`) para que reenviar o mesmo valor não grave nem audite.
- **Itens**: o DOC-07 genérico (`document`) ganhou `specification`/`acceptanceCriteria` (rich text,
  `itemRichTextIssue`) e o teto de `notes` por tipo (`notesMax` — 5.000 no TR). Sem versão nova
  (RN-TR-33); `document.items_update` com os textos como hash + tamanho.
- **Web**: `term-items-panel.tsx` (+ `term-items-model.ts`) e `term-conditions-panel.tsx`
  (+ `term-conditions-model.ts`), abertos sob demanda na SCR-012.
- **Testes**: `domain/term-of-reference.spec.ts`, `presentation/term-conditions.routes.spec.ts` (8
  categorias + FA-01/02/03, V-04/V-09/V-10) e `test/tenant-leak/term-items.spec.ts` (PostgreSQL:
  jsonb, CHECKs, unicidade, RLS, 5 PATCHes paralelos, falha induzida nos itens).
