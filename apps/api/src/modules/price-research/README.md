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

## US-027 — Desconsiderar e restaurar cotação com justificativa (PRS-16/17)

- **Rotas** (`presentation/price-source.controller.ts`): PRS-16 `POST /quotations/{id}/exclude`
  (`exclusionReason` + `exclusionJustification` ≥ 20, `If-Match` da cotação) e PRS-17
  `POST /quotations/{id}/restore`. Contrato em `excludeQuotationSchema`
  (`packages/validation/src/price-research/price-sources.ts`) e eventos `QuotationExcluded`/
  `QuotationRestored` (`price-research/events.ts`).
- **Permissão própria**: `PRICE_RESEARCH_EXCLUDE_QUOTATION` no lugar da de edição. O
  `TypedCollectionInput.permission` (fachada do `document`) troca só a permissão da POL-02 estendida;
  as demais travas (custódia, processo, etapa, documento `DRAFT`/`RETURNED`, POL-09) valem iguais.
  `meta.allowedActions` ganhou `EXCLUDE_QUOTATION` (`PriceResearchGate.canExcludeQuotation`).
- **Domínio** (`domain/price-source.ts`): `excludeQuotation`/`restoreQuotation` e
  `excludeBlockedBy`/`restoreBlockedBy` (409 `INVALID_STATE` com o estado atual).
- **Escrita** (`ExcludeQuotationCommand`/`RestoreQuotationCommand`): mesma guarda das demais
  gravações (linha da pesquisa travada); numa transação só — cotação (`If-Match`), versão nova da
  fonte (invalida a grade aberta), auditoria + evento da transição, recálculo
  (`PriceResearchRecalculated` logo depois) e a timeline pelo projetor síncrono. Justificativa nunca
  em log, evento nem timeline; na auditoria, hash + tamanho.
- **Timeline**: `PriceResearchFacade.priceItemSequences`/`quotationSourceLabels` alimentam as fontes
  `PRICE_ITEM`/`QUOTATION` do `TimelineProjector` (`QUOTATION_EXCLUDED`/`QUOTATION_RESTORED`).
- **Sem migração**: colunas e o CHECK `quotations_excluded_reason` vêm da US-026.
- **Testes**: `domain/price-source.spec.ts`, `presentation/quotation-exclusion.routes.spec.ts`
  (8 categorias + FA-01..03) e `test/tenant-leak/quotation-exclusion.spec.ts` (PostgreSQL).

## US-028 — Importar cotações por planilha (PRS-18/19/24)

- **Rotas** (`presentation/quotation-import.controller.ts`): PRS-24 `GET /price-research/{id}/import-template`
  (modelo `.xlsx`), PRS-18 `POST …/import-preview` (corpo `multipart/form-data`, campo `file`) e PRS-19
  `POST …/import` (`{ previewToken }`, Idem.). Contratos em
  `packages/validation/src/price-research/quotation-import.ts` (limites, cabeçalhos e mensagens — os
  mesmos no web).
- **Planilha** (`#shared/spreadsheet/`): ZIP e XLSX próprios sobre `node:zlib` (sem dependência nova):
  escrita determinística de uma aba e leitura defensiva (limite de entradas e de bytes descompactados,
  varredura linear do XML — sem retrocesso de regex sobre o conteúdo do usuário; textos compartilhados,
  texto rico, fórmulas com resultado). É a camada que o mapa comparativo (US-031, PRS-22) deve reaproveitar.
- **Upload**: o `JsonBodyMiddleware` deixa o corpo multipart sem ler só nas rotas de `MULTIPART_ROUTES`
  (`#shared/http/multipart.ts`); o controller lê o arquivo depois da guarda, com o limite
  `uploads.maxFileSizeMb` do tenant (413), e drena o corpo quando a requisição é recusada antes.
- **Domínio** (`domain/quotation-import.ts`): cabeçalhos normalizados (acento, caixa, espaços); a coluna
  do item é `Item` (ou `Sequência`) e as das fontes, pela descrição (FA-02 — ordem livre; coluna sem
  fonte = aviso). Preço: número arredondado a 15 dígitos significativos (ruído de ponto flutuante do
  Excel) ou texto com `R$`/milhar/vírgula decimal; depois a mesma validação da grade (`unitPriceIssue`).
  `planImportApplication` aplica sobre as cotações vigentes (a pesquisa está travada).
- **Token** (`application/quotation-import.store.ts`): `TenantCache` módulo `price-import`, prévia com as
  células válidas (TTL 15 min) + marcador `issued:` (24 h) que distingue vencido (410) de desconhecido
  (404); amarrado à pesquisa e ao usuário; consumido depois da aplicação (reuso com outra chave = 410;
  com a mesma chave a idempotência repete a resposta).
- **Aplicação** (`ApplyQuotationImportCommand`): guarda (`PriceSourceGate.writable`) → token → cria/atualiza
  as cotações em lote → versão nova das fontes tocadas → `price_research.import` → um único recálculo
  (`PriceResearchRecalculated`). Sem auditoria por cotação (seria uma linha por célula).
- **Testes**: `domain/quotation-import.spec.ts`, `application/quotation-import.store.spec.ts` (TTL de 15
  min), `#shared/spreadsheet/xlsx.spec.ts`, `#shared/http/multipart.spec.ts`,
  `presentation/quotation-import.routes.spec.ts` (8 categorias + FA-01..06) e
  `test/tenant-leak/quotation-import.spec.ts` (PostgreSQL).
