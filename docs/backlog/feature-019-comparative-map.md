---
id: FT-019
title: "Mapa comparativo"
epic: EP-004
mvp: 1
priority: P0
stories: [US-031]
status: Especificada
---

# FT-019 — Mapa comparativo

## Título
Mapa comparativo

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre a visualização da pesquisa como uma matriz itens × fontes — cada célula é o preço cotado, com seus selos de status/outlier/vencimento, encerrando cada linha com as estatísticas e o valor recomendado do item — e a exportação dessa matriz em XLSX (síncrona) ou PDF (rendition do documento, seção `PRICE_SUMMARY`).

## Valor para o usuário e para o órgão
- Permite avaliar a pesquisa inteira num único painel antes de concluí-la, em vez de abrir fonte por fonte.
- Gera a evidência documental (XLSX/PDF) para anexar ao processo, sem montagem manual de planilha.

## Personas
- Integrante da equipe de planejamento da contratação (`PLANEJAMENTO`) — revisa e exporta o mapa.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-031 | Visualizar e exportar o mapa comparativo | P0 | M | US-029, US-067 |

## Escopo
- Tela SCR-010 com a matriz itens (linhas, por `sortOrder`) × fontes (colunas, por `sortOrder`).
- Exportação XLSX síncrona, limitada a 500 itens × 50 fontes.
- Exportação PDF via rendition do documento `PRICE_RESEARCH` (seção computada `PRICE_SUMMARY`).

## Fora de escopo
- Cálculo das estatísticas/alertas exibidos — FT-018.
- Lançamento de preços a partir do mapa (tela é somente leitura) — FT-017.

## Regras de negócio da feature
- RN-PRICE-53 a RN-PRICE-57 — US-031.

## Telas
- SCR-010 — Mapa comparativo (`/processos/[id]/pesquisa-precos/[researchId]/mapa`)

## Endpoints
- PRS-21 `GET /price-research/{id}/comparative-map` — matriz
- PRS-22 `GET /price-research/{id}/comparative-map/export?format=xlsx` — exportação XLSX
- DOC-20, DOC-21, DOC-22, DOC-23 — geração/consulta de rendition PDF do documento (US-067)

## Entidades
- `PriceItem`, `PriceSource`, `Quotation` — consumidas (linha, coluna, célula)
- `Document` / `DocumentRendition` — geração do PDF

## Eventos
- Nenhum evento de domínio próprio (feature de leitura); auditoria de exportação (`price_research.export`).

## Permissões
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver valores monetários do mapa quando o processo é sigiloso (POL-09)

## Dependências
- Stories: US-029 (estatísticas), US-030 (alertas/outliers), US-026 (fontes/cotações), US-067 (renditions). Indireta: US-024.
- Decisões: DEC-017, DEC-020, DEC-024, DEC-030/POL-09.
- Habilitada por esta feature: US-028 (reaproveita o layout do mapa como modelo de importação).

## Critérios de aceite da feature
```gherkin
Feature: Mapa comparativo
  Scenario: Exportar o mapa em XLSX dentro do limite
    Given uma pesquisa com 10 itens e 4 fontes, todas com cotações lançadas
    When o usuário exportar o mapa comparativo em XLSX
    Then o arquivo deve conter uma linha por item, uma coluna por fonte e a estatística/valor recomendado ao final de cada linha

  Scenario: Tentar exportar acima do limite síncrono
    Given uma pesquisa com 600 itens
    When o usuário exportar o mapa comparativo em XLSX
    Then a API deve responder 422 "EXPORT_TOO_LARGE"
```

## Métricas de sucesso
- 100% das exportações XLSX dentro do limite concluídas em uma única requisição síncrona.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Pesquisas grandes (acima de 500 itens × 50 fontes) não conseguirem exportar em XLSX | Baixa | Médio | `EXPORT_TOO_LARGE` orienta a refinar filtros; exportação assíncrona/paginada fica para MVP futuro |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
