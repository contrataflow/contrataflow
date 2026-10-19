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
- **Fora desta story**: importação do ETP (TRM-05/06, US-037), condições contratuais e itens
  (US-038), validador tipado e conclusão (US-039).
