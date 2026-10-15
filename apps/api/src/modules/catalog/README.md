# `catalog`

Catálogos, calendário de dias úteis e numeração (DEC-040).

- **Catálogos parametrizáveis (US-104):** `CatalogItem` por tenant e `catalogType` (8 catálogos),
  CAT-01..06, `metadata` validada por tipo (`@contrataflow/validation` · `catalogMetadataSchema`),
  seeder `catalog.items` (84 itens de sistema) e `CatalogFacade.assertActive(tx, tipo, id, campo)` —
  o ponto único que os demais módulos usam para validar referência a item ativo, do catálogo e do
  tenant corretos. Nenhum item é excluído (RN-TEN-64): o ciclo de vida é a desativação.
