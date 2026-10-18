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
