---
id: FT-017
title: "Fontes e cotações"
epic: EP-004
mvp: 1
priority: P0
stories: [US-026, US-027, US-028]
status: Especificada
---

# FT-017 — Fontes e cotações

## Título
Fontes e cotações

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre o registro das evidências de pesquisa exigidas pelo art. 23 da Lei 14.133/2021 — fontes (`PriceSource`: orçamento, painel de preços, contratação similar, sítio eletrônico, pesquisa direta etc.) e, para cada fonte, o preço cotado de cada item (`Quotation`) —, com exclusão justificada e restauração, e importação em lote por planilha para pesquisas grandes.

## Valor para o usuário e para o órgão
- Reúne, por fonte, exatamente os campos exigidos pela Lei 14.133 (data, momento de acesso, órgão de referência, justificativa de escolha do fornecedor), configuráveis por tipo de fonte.
- Permite descartar uma cotação inconsistente sem perder o histórico, e lançar pesquisas grandes por planilha em vez de célula a célula.

## Personas
- Responsável pela pesquisa de preços (`PLANEJAMENTO`) — registra fontes, lança preços, desconsidera/restaura cotações e importa planilhas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-026 | Registrar fontes de pesquisa e cotações | P0 | L | US-024, US-025, US-068 |
| US-027 | Desconsiderar e restaurar cotação com justificativa | P0 | S | US-026 |
| US-028 | Importar cotações por planilha | P2 | M | US-026, US-068 |

## Escopo
- Cadastro de `PriceSource` com campos condicionados ao tipo (`PRICE_SOURCE_TYPE.metadata.requiredFields`) e anexo de evidência.
- Lançamento de `Quotation` em grade (todos os itens de uma fonte de uma vez) e edição unitária.
- Desconsideração (`EXCLUDED`) com motivo e justificativa de no mínimo 20 caracteres; restauração para `VALID`.
- Importação por planilha: modelo pré-preenchido, prévia com erro por linha/célula (token de 15 min) e aplicação atômica.

## Fora de escopo
- Cálculo de estatísticas e valor recomendado — FT-018.
- Sinalização de outliers e alertas — FT-018.

## Regras de negócio da feature
- RN-PRICE-21 a RN-PRICE-29 — US-026.
- RN-PRICE-30 a RN-PRICE-34 — US-027.
- RN-PRICE-35 a RN-PRICE-40 — US-028.

## Telas
- SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`)

## Endpoints
- PRS-09 `GET /price-research/{id}/sources` — listar fontes
- PRS-10 `POST /price-research/{id}/sources` — criar fonte
- PRS-11 `PATCH /price-sources/{sourceId}` — editar fonte
- PRS-12 `DELETE /price-sources/{sourceId}` — remover fonte (cascata de cotações)
- PRS-13 `PUT /price-sources/{sourceId}/quotations` — grade de preços da fonte
- PRS-14 `PATCH /quotations/{quotationId}` — editar cotação
- PRS-15 `DELETE /quotations/{quotationId}` — remover cotação
- PRS-16 `POST /quotations/{quotationId}/exclude` — desconsiderar
- PRS-17 `POST /quotations/{quotationId}/restore` — restaurar
- PRS-18 `POST /price-research/{id}/import-preview` — prévia da importação
- PRS-19 `POST /price-research/{id}/import` — aplicar importação
- PRS-24 `GET /price-research/{id}/import-template` — baixar modelo
- ATT-02 `POST /attachments` — upload de evidência (US-068)

## Entidades
- `PriceSource`, `Quotation` — dono da feature
- `Supplier` — consumida (FT-016)
- `CatalogItem` (`PRICE_SOURCE_TYPE`) — consumida

## Eventos
- `PriceResearchRecalculated` — toda criação, edição, remoção, exclusão, restauração ou importação de fonte ou cotação
- `QuotationExcluded` / `QuotationRestored` — US-027

## Permissões
- `PRICE_RESEARCH_UPDATE` — registrar/editar fontes e cotações, importar
- `PRICE_RESEARCH_EXCLUDE_QUOTATION` — desconsiderar/restaurar
- `SUPPLIER_VIEW` — selecionar fornecedor ao registrar fonte

## Dependências
- Stories: US-024 (pesquisa e itens já existem), US-025 (fornecedores), US-068 (upload de anexos — intenção/confirmação/varredura).
- Decisões: DEC-003, DEC-010, DEC-017, DEC-020, DEC-030.
- Habilitada por esta feature: US-029 (estatísticas), US-030 (outliers/alertas), US-031 (mapa consome fontes/cotações).

## Critérios de aceite da feature
```gherkin
Feature: Fontes e cotações
  Scenario: Registrar uma fonte, lançar preços e desconsiderar uma cotação inconsistente
    Given uma pesquisa de preços em rascunho com 2 itens e nenhuma fonte
    When o usuário registrar uma fonte do tipo "Orçamento com fornecedor" e lançar o preço dos 2 itens na grade
    Then as 2 cotações devem nascer "VALID" e disparar o recálculo da pesquisa
    When o usuário desconsiderar uma delas com motivo "INCONSISTENT" e justificativa de pelo menos 20 caracteres
    Then essa cotação deve passar a "EXCLUDED" e sair das estatísticas do item, permanecendo visível com o motivo
```

## Métricas de sucesso
- Tempo médio de lançamento de uma pesquisa com 20+ itens via importação ≤ 30% do tempo via grade manual.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Campos exigidos por tipo de fonte mal configurados no catálogo do tenant, bloqueando o lançamento | Baixa | Médio | `QUOTATION_REQUIRED_FIELDS` aponta exatamente o campo ausente; catálogo `PRICE_SOURCE_TYPE` semeado com os tipos do art. 23 |
| Importação (US-028, P2) atrasar e a equipe lançar tudo manualmente na grade (US-026, P0) | Média | Baixo | A grade já cobre o fluxo completo; a importação é aceleração, não pré-requisito |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
