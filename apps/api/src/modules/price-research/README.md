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
- **Cálculo nesta story**: alerta inicial `NO_VALID_QUOTES` (RN-PRICE-50 da US-030) e contadores
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

## US-029 — Calcular estatísticas e valor estimado por item (PRS-04/05/07/20)

- **Motor** (`domain/price-calculation.ts`, puro, `decimal.js` com contexto próprio de 28 dígitos):
  `priceStatistics` (RN-PRICE-41: n, média, mediana, menor, maior; desvio amostral `n − 1` e CV só
  com n ≥ 2), `effectiveMethodOf` (RN-PRICE-42: `methodOverride` → padrão; `AUTO_CV` = `MEDIAN` se
  o CV gravado (4 casas) > limiar, senão `MEAN`), `calculatePriceItem` (RN-PRICE-43/44: recomendado
  a partir do valor sem arredondar, `unitPriceDecimals` casas pelo `roundingMode`; `MANUAL` usa o
  valor informado como está; total `round(unit × qtd, 2)`) e `totalEstimatedValueOf` (soma dos
  totais). Estatísticas pelo `roundingMode` do snapshot, na escala das colunas.
- **`recalculate`/`recalculateItem`** (`domain/price-research.ts`): idempotentes — só as linhas cujo
  resultado mudou voltam em `changedItems`. O item já nasce calculado (`createPriceItem`), para que
  o primeiro recálculo não regrave (e mude a versão de) todos os itens.
- **`PriceCalculationService`** (`application/price-calculation.service.ts`): o recálculo da pesquisa
  dentro da transação de quem chama (linha travada pela guarda), com `price_research.recalculate`
  (`trigger`), `PriceResearchRecalculated`, log `price_research.recalculated`/`_slow` (> 1 s)/
  `_failed` e o histograma `price_research_recalculate_duration_ms` — sem valores. O
  `QuotationRecalculator` (US-026/027/028) e os PRS-04/06/08 delegam a ele.
- **PRS-07** (`UpdatePriceItemCommand`): guarda → item relido depois da trava (`If-Match` do item) →
  `planPriceItemUpdate` (V-01/V-02/V-05, FA-01/FA-02; reenvio igual não grava) → item gravado já
  recalculado (`updateItem`, `version + 1`) → `price_research.method_change` se o método mudou →
  recálculo da pesquisa. Regras do valor manual compartilhadas com a SCR-009 (`manualPriceIssues`).
- **PRS-04** (RN-PRICE-47): parâmetros de cálculo editáveis (`calculationParameterChanges`); prazos de
  validade seguem fixos. Recálculo com o cabeçalho novo numa única gravação.
- **PRS-20** (`RecalculatePriceResearchCommand`): transação dedicada; 503 sem alterar nada.
- **SCR-009**: `PriceItemStatsCard`/`MethodSelect`/`ManualPriceFieldset`/`RecalculateButton`
  (`apps/web/src/features/price-research/price-item-calculation.tsx`) e o editor de parâmetros no
  `ParametersPanel`.
- **Testes**: `domain/price-calculation.spec.ts` (0/1/2/N cotações, `AUTO_CV`, arredondamentos),
  `domain/price-item-update.spec.ts`, `presentation/price-calculation.routes.spec.ts` (8 categorias +
  FA-01..06) e `test/tenant-leak/price-calculation.spec.ts` (PostgreSQL: colunas decimais, falha
  induzida, concorrência, RLS e CHECK do manual).

## US-030 — Sinalizar outliers e alertas de conformidade (PRS-03/05)

- **Sem rota nova**: estende o `PriceCalculationService` — todo recálculo (PRS-04/06/07/08/13/14/15/16/17/19/20)
  avalia as cotações e consolida os alertas na MESMA transação das estatísticas (nunca estatística nova
  com alerta antigo).
- **Domínio**: `flagOutlier`/`outlierFlagsOf` (`domain/price-calculation.ts` — mediana das DEMAIS
  cotações `VALID` do item, `decimal.js`, menos de 2 outras = `NONE`; RN-PRICE-48), `assessQuotations`/
  `quotationFactsByItem` (`domain/price-source.ts` — `EXCLUDED` fica `NONE` e fora da mediana, RN-PRICE-52;
  validade pelo `isSourceExpired` com a regra ATUAL do tipo no catálogo, RN-PRICE-49) e `consolidateAlerts`
  (`domain/price-research.ts` — RN-PRICE-50: `NO_VALID_QUOTES` sozinho com 0 válidas, `BELOW_MINIMUM_QUOTES`
  só com `0 < válidas < mínimo`, `HIGH_CV` com o CV gravado e ≥ 2 válidas, `HAS_OUTLIERS`, `EXPIRED_QUOTES`).
  Nada é excluído automaticamente (DEC-020).
- **Gravação**: `PriceSourceRepository.updateAssessments` grava `outlier_flag`/`is_expired` só das cotações
  que mudaram, **sem `version + 1`** (campos do sistema: não invalidam o `If-Match` de quem edita outra
  cotação). PRS-14/16/17 relêem a cotação depois do recálculo (a resposta traz o destaque atual).
  `PriceSourceRulesReader`/`rulesOf` foram para `application/price-source-rules.ts` (o serviço os usa sem
  ciclo de import; `price-source.support.ts` os reexporta).
- **Auditoria/logs**: `price_research.recalculate` ganhou `metadata.alertsChanged`; logs
  `price_research.alerts_changed` (por item, só códigos) e `price_research.outlier_calc_slow` (> 300 ms) —
  nunca preços nem percentuais.
- **Validação**: V-01 — `outlierFlag`/`isExpired` no PATCH da cotação (`QUOTATION_CALCULATED_FIELDS`) e
  `alerts` no PRS-07 → 422 `NOT_ALLOWED`; V-02 — `outlierRangeErrors` no PRS-04 (inferior ≥ superior →
  `OUT_OF_RANGE` nos dois campos).
- **SCR-009**: `AlertBadgeList`, `OutlierBadge`, `ExpiredBadge` (`apps/web/src/features/price-research/
price-alert-badges.tsx` — texto + tooltip focável; sob POL-09 sem percentuais) na tabela de itens, na
  grade de preços e a contagem de destoantes no cartão da fonte.
- **Testes**: `domain/price-alerts.spec.ts`, `presentation/price-alerts.routes.spec.ts` (8 categorias +
  FA-01/03/04/05, V-01/V-02), `test/tenant-leak/price-alerts.spec.ts` (PostgreSQL: colunas, jsonb, rollback,
  concorrência, RLS), `test/price-research/price-outliers.perf.ts` (50 fontes/item < 300 ms) e o E2E
  "cotação destoante" em `apps/web/test/e2e/price-research.spec.ts`.

## US-031 — Visualizar e exportar o mapa comparativo (PRS-21/22 · PDF pelo DOC-20..23)

- **Rotas** (`presentation/comparative-map.controller.ts`): PRS-21 `GET /price-research/{id}/comparative-map`
  e PRS-22 `GET …/comparative-map/export?format=xlsx` (_rate limit_ `export`). Contratos em
  `packages/validation/src/price-research/comparative-map.ts` (`comparativeMapSchema`, limites, mensagens,
  rótulos do arquivo e `PRICE_SUMMARY_COLLECTIONS`). 404 próprio: `PRICE_RESEARCH_NOT_FOUND`.
- **Domínio** (`domain/comparative-map.ts`, puro): `buildComparativeMap` (RN-PRICE-53 — linhas/colunas por
  `sortOrder`, células só onde há cotação), `maskComparativeMap`/`comparativeMapFor` (POL-09 num passo único,
  o mesmo para a tela e o XLSX) e `comparativeMapSnapshot` (coleções do PDF).
- **Leitura** (`application/comparative-map.queries.ts`): `ComparativeMapAssembler` monta o mapa no `tx` de
  quem chama; `ComparativeMapReader` confere a visibilidade (DEC-024) e decide a POL-09; PRS-21/22 leem numa
  única transação de leitura (FA-05). `ExportComparativeMapXlsxCommand`: teto 500 × 50 (422 antes de
  montar), aviso `price_research.export_near_limit` acima de 80%, `price_research.export` gravado depois de
  montar o arquivo (falha → 503 sem bytes), logs `price_research.map_exported`/`export_failed` sem preços.
- **Planilha** (`application/comparative-map.xlsx.ts`): reaproveita `#shared/spreadsheet/xlsx`; preços
  numéricos, selos na coluna "Observações", "Sigiloso" quando mascarado; determinística.
- **PDF**: `PriceResearchDocumentValidator` (porta `DocumentValidator`, registrado no `onModuleInit`) põe o
  mapa sem máscara nas coleções `priceSummary*` do snapshot (prévia = estado vigente; versão = congelado);
  o `document` mascara pela rendition e renderiza a seção `PRICE_SUMMARY` (`document/domain/price-summary-html.ts`).
  `validate` não acrescenta regras (a conclusão é da US-032).
- **Testes**: `domain/comparative-map.spec.ts`, `application/comparative-map.xlsx.spec.ts`,
  `document/domain/price-summary-html.spec.ts`, `presentation/comparative-map.routes.spec.ts` (8 categorias
  - FA-01/02/03/04/05, V-01/V-02, PDF pelo `document-render`), `test/tenant-leak/comparative-map.spec.ts`
    (PostgreSQL: auditoria EXPORT, 500 × 50 / 501 / 51 por SQL, POL-09, leituras sob exclusões concorrentes,
    tenant B) e `test/price-research/comparative-map-export.perf.ts` (500 × 50 < 1 s, suíte de performance).

## US-032 — Concluir a pesquisa de preços (PRS-23 · PRS-07 com a justificativa)

- **Rota** (`presentation/price-research.controller.ts`): PRS-23 `POST /price-research/{id}/complete`
  (`{}`, `If-Match` = versão da pesquisa, `Idempotency-Key`). Contratos em
  `packages/validation/src/price-research/completion.ts` (`priceItemCompletionIssue`, mensagens,
  `completedPriceResearchSchema`, `PriceResearchCompletedSummary`) — os mesmos na SCR-009.
- **Comando** (`application/price-research-completion.command.ts`): guarda com
  `PRICE_RESEARCH_COMPLETE` (`COMPLETE_OPTIONS` — POL-02 estendida + POL-09 + `FOR UPDATE`; 404 próprio
  `PRICE_RESEARCH_NOT_FOUND`) → `If-Match` (documento já concluído com versão velha = 412, não 409) →
  completude (RN-PRICE-58/59 → 422 `PRICE_RESEARCH_INCOMPLETE`) → `DocumentFacade.finalizeIn` (a MESMA
  finalização do DOC-10, avisos genéricos reconhecidos). Log `price_research.completed`/`_blocked`/
  `_failed` e o histograma `price_research_complete_duration_ms` — sem valores.
- **Validador** (`PriceResearchDocumentValidator`): `validate` devolve as mesmas violações (DOC-08/10);
  `typedSummary` = `{ totalEstimatedValueMasked, itemsCount, itemsWithAlertsCount }`; `snapshotParts`
  acrescenta às linhas `priceSummaryItems` os campos de exceção do item (FA-02); o gancho `finalized`
  (porta nova do `document`) grava `completedAt`/`completedById`, chama
  `ProcessFacade.applyPriceResearchReferenceIn` (itens + valor estimado com a precedência da DEC-032 —
  `TERM` mantém o valor) e audita `price_research.complete` (valor anterior/novo; hash + `masked` se
  sigiloso). Tudo na transação da finalização: falha em qualquer passo desfaz o documento.
- **PRS-07**: `belowMinimumJustification` (20–4.000, vazio/`null` apaga — `TOO_SHORT`), sem recálculo
  de preço novo; nunca em auditoria/evento.
- **ETP**: sem código novo — o `EtpEstimateSynchronizer` do worker já assina
  `document.finalized.price_research`; sem ETP vinculado avisa `price_research.etp_sync_skipped`.
- **Testes**: `domain/price-research-completion.spec.ts`, `domain/price-item-update.spec.ts`,
  `presentation/price-completion.routes.spec.ts` (8 categorias + FA-02/03, MANUAL, DEC-032, POL-09,
  DOC-10) e `test/tenant-leak/price-completion.spec.ts` (PostgreSQL: atomicidade com falha induzida
  depois da finalização, concorrência 200/412, RLS, outbox PENDING).
