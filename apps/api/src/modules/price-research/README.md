# `price-research`

Pesquisa de preços: itens, fontes, cotações e estatística (DEC-040, nível 4). Dono de
`PriceResearch` — o cabeçalho tipado 1:1 do `Document` do tipo `PRICE_RESEARCH` (DEC-020) — e de
`PriceItem`. Segue o padrão de documento tipado do DFD (`dfd/README.md`).

## US-024 — Criar pesquisa de preços a partir dos itens do processo (PRS-01..06/08)

- **Rotas** (`presentation/price-research.controller.ts`): PRS-01 `GET /processes/{id}/price-research`,
  PRS-02 `POST /processes/{id}/price-research` (Idem.), PRS-03 `GET /price-research/{id}`, PRS-04
  `PATCH /price-research/{id}` (`If-Match`), PRS-05 `GET /price-research/{id}/items`, PRS-06
  `POST /price-research/{id}/items`, PRS-08 `DELETE /price-items/{itemId}` (`If-Match` do item).
  Contratos em `packages/validation/src/price-research/` (`createPriceResearchSchema`,
  `priceItemQuantityIssue`, `referenceDateIssue`, `PriceResearchRecalculated`).
- **id da pesquisa = id do documento** (CHECK `price_research_id_is_document`): SCR-009
  (`/processos/{id}/pesquisa-precos/{researchId}`), painel de documentos, seções (DOC-05), versões e
  PDF usam o mesmo identificador.
- **Criação** (`CreatePriceResearchCommand`, uma transação — RN-PRICE-13): visibilidade (404) →
  itens e data-base (422, um único `errors[]`) → `DocumentFacade.createStructuredIn` (template
  publicado, `PRICE_RESEARCH_CREATE` + custódia POL-01 + POL-02, `beforeCreate` com
  `PRICE_ITEMS_REQUIRED`, singular 409, número `PP {seq:4}/{year}`, `RESTRICTED` com orçamento
  sigiloso, `document.create` com `itemsCount`/`parameters`, `DocumentCreated`
  `document.created.price_research`, timeline) → `price_research` com o snapshot de
  `priceResearch.*` → `price_items` em lote (`createMany`). Quantidade padrão (RN-PRICE-04):
  `ProcessItem.referenceQuantity` → ETP não cancelado → DFD (`DocumentFacade.itemQuantitiesIn`).
- **Mutações** (`PriceResearchGate.writable`): POL-02 estendida pela fachada do `document` (trava o
  documento dono), documento em `DRAFT`/`RETURNED`, POL-09 (403 `reasonCode = POL-09` —
  RN-PRICE-12) e `SELECT … FOR UPDATE` da linha da pesquisa. PRS-04/06/08 emitem
  `PriceResearchRecalculated` (só ids e contadores); PRS-06/08 gravam `document.items_update`,
  PRS-04 `document.draft_update` (título como impressão digital).
- **Cálculo nesta story**: alertas iniciais `NO_VALID_QUOTES`/`BELOW_MINIMUM_QUOTES` e contadores
  (`quotationAlerts`, `countersOf`, `recalculate`). Estatística, método e totais = US-029/US-030;
  cotações (e a contagem `quotationsCount`, hoje sempre 0) = US-026.
- **Uso do item** (`PriceItemUsageReader`): registrado no `ProcessItemUsageRegistry` — excluir item
  do processo referenciado por pesquisa → 409 `ITEM_IN_USE`.
- **Testes**: `domain/price-research.spec.ts`, `presentation/price-research.routes.spec.ts` (8
  categorias do Gherkin + FA-03/04/05/07/09) e `test/tenant-leak/price-research.spec.ts`
  (PostgreSQL: atomicidade com falha induzida, 20 criações paralelas, RLS, FKs, cascata).

## US-026 — Registrar fontes de pesquisa e cotações (PRS-09..15)

- **Rotas** (`presentation/price-source.controller.ts`): PRS-09 `GET /price-research/{id}/sources`
  (fontes com tipo, fornecedor e cotações; POL-09 no preço), PRS-10 `POST …/sources` (Idem.), PRS-11
  `PATCH /price-sources/{id}`, PRS-12 `DELETE /price-sources/{id}`, PRS-13
  `PUT /price-sources/{id}/quotations` (grade; `If-Match` da fonte, Idem. opcional), PRS-14
  `PATCH /quotations/{id}` e PRS-15 `DELETE /quotations/{id}` (`If-Match` da cotação). Contratos em
  `packages/validation/src/price-research/price-sources.ts` (`missingPriceSourceFields`,
  `unitPriceIssue`, `PRICE_SOURCE_MESSAGES` — os mesmos no web).
- **Domínio** (`domain/price-source.ts`): campos exigidos pelo tipo (`requiredFields` do catálogo
  `PRICE_SOURCE_TYPE`, lidos na gravação — o anexo nunca é exigido na API, RN-PRICE-28), datas não
  futuras, validade (`isSourceExpired`: snapshot `directQuoteMaxAgeDays`/`similarContractMaxAgeDays`
  para pesquisa direta/contratação similar, `maxAgeDays` do catálogo para os demais) e o plano da
  grade (`planQuotationGrid`: linha vazia não altera, idêntica é ignorada, `EXCLUDED` → 409).
- **Escritas** (`application/price-source.commands.ts`): `PriceSourceGate` = `PriceResearchGate.writable`
  (POL-02 estendida + documento editável + POL-09 + `FOR UPDATE` da pesquisa — serializa as gravações
  e faz a segunda do mesmo `If-Match` receber o 412) e relê a fonte/cotação depois da trava. Toda
  gravação termina no `QuotationRecalculator` (RN-PRICE-27: `validQuotationsCount` = cotações `VALID`,
  alertas, contadores, `lastCalculatedAt`, versão da pesquisa + 1 e `PriceResearchRecalculated`).
  Mudanças de cotação sobem a versão da fonte. PRS-04 com data-base nova reavalia `isExpired`.
- **Integrações**: tipos de fonte pela `CatalogFacade.assertActivePriceSourceType`/`priceSourceTypesOf`;
  fornecedor pela `SupplierFacade.assertActive`/`summariesOf`; uso do fornecedor (SUP-05) pelo
  `PriceSourceSupplierUsage`; alvo de anexo `PRICE_SOURCE` (`PriceSourceAttachmentTargets`) delega
  ao alvo `DOCUMENT` da pesquisa (visibilidade, POL-02 de edição e sigilo do arquivo).
- **Banco**: migração `20261018140000_price_sources` (`price_sources`, `quotations`, enums
  `quotation_status`/`exclusion_reason`/`outlier_flag`), RLS, FKs compostas e cascatas; remoção física.
- **Testes**: `domain/price-source.spec.ts` (todos os tipos semeados), `presentation/price-sources.routes.spec.ts`
  (8 categorias + FA-01..08) e `test/tenant-leak/price-sources.spec.ts` (PostgreSQL).
