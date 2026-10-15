# `catalog`

Catálogos, calendário de dias úteis e numeração (DEC-040).

- **Catálogos parametrizáveis (US-104):** `CatalogItem` por tenant e `catalogType` (8 catálogos),
  CAT-01..06, `metadata` validada por tipo (`@contrataflow/validation` · `catalogMetadataSchema`),
  seeder `catalog.items` (84 itens de sistema) e `CatalogFacade.assertActive(tx, tipo, id, campo)` —
  o ponto único que os demais módulos usam para validar referência a item ativo, do catálogo e do
  tenant corretos. Nenhum item é excluído (RN-TEN-64): o ciclo de vida é a desativação.
- **Numeração (US-105 · DEC-028):** `NumberingFacade` é o ponto único de número de processos e
  documentos. `assignProcessNumber(tx, { organizationId })` e `assignDocumentNumber(tx, {...})`
  rodam NA transação do recurso numerado (`UPDATE number_sequences … RETURNING` bloqueia a linha até
  o commit; o rollback devolve o número) e devolvem `{ sequenceKey, number, year, code }`. Quem cria
  ou autua o processo decide o momento (`numbering.process.assignOn`); a fachada só numera. O escopo
  do ano é o da primeira sequência de processo aberta nele (mudança de escopo vale no próximo
  exercício) e documentos numeram por tipo e ano no tenant. SET-04 (`PreviewNumberingMaskQuery`) é
  a prévia somente leitura.
