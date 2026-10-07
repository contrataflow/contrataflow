---
id: FT-015
title: "Pesquisa e itens"
epic: EP-004
mvp: 1
priority: P0
stories: [US-024]
status: Especificada
---

# FT-015 — Pesquisa e itens

## Título
Pesquisa e itens

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre a criação da pesquisa de preços a partir dos itens da contratação já cadastrados no processo, com o snapshot dos parâmetros vigentes do tenant (método padrão, mínimo de cotações, validade das fontes, faixas de outlier, decimais do preço). É a porta de entrada do épico: estabelece o documento `PRICE_RESEARCH`, o cabeçalho tipado e um `PriceItem` por item selecionado, sobre os quais as demais features (fontes, cálculos, mapa, conclusão) atuam. Enquanto em rascunho, também cobre o ajuste de data-base, inclusão/remoção de itens e de quantidades.

## Valor para o usuário e para o órgão
- Elimina a redigitação de itens e quantidades já levantados no processo.
- Garante que os parâmetros de cálculo usados na pesquisa fiquem congelados (snapshot) no momento da criação, independentemente de mudanças futuras na configuração do tenant.

## Personas
- Agente de compras / equipe de planejamento (`PLANEJAMENTO`) — cria a pesquisa e ajusta itens/quantidades antes de registrar fontes.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-024 | Criar pesquisa de preços a partir dos itens do processo | P0 | M | US-006, US-065, US-110 |

## Escopo
- Criação do `PriceResearch` (documento `STRUCTURED`) a partir do template padrão publicado, em transação única com documento, cabeçalho, itens, auditoria, outbox e timeline.
- Seleção dos itens não excluídos do processo (todos por padrão, com ao menos um obrigatório) e quantidade padrão herdada de `ProcessItem`/ETP/DFD.
- Snapshot imutável dos parâmetros `priceResearch.*` no cabeçalho da pesquisa (DEC-020).
- Edição, enquanto o documento estiver editável: data-base, título, inclusão/remoção de itens, ajuste de quantidade.

## Fora de escopo
- Registro de fontes e lançamento de cotações — FT-017.
- Cálculo de estatísticas e preço recomendado — FT-018.
- Validação de completude e conclusão — FT-020.

## Regras de negócio da feature
- RN-PRICE-01 a RN-PRICE-13 — US-024.

## Telas
- SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`)

## Endpoints
- PRS-01 `GET /processes/{id}/price-research` — verificar pesquisa existente do processo
- PRS-02 `POST /processes/{id}/price-research` — criar a pesquisa
- PRS-03 `GET /price-research/{id}` — detalhe da pesquisa
- PRS-04 `PATCH /price-research/{id}` — editar cabeçalho (data-base, título)
- PRS-05 `GET /price-research/{id}/items` — listar itens da pesquisa
- PRS-06 `POST /price-research/{id}/items` — incluir item
- PRS-08 `DELETE /price-items/{itemId}` — remover item
- DOC-05 `PUT /documents/{id}/sections/{sectionKey}` — autosave das seções narrativas (`METHODOLOGY`, `CONCLUSION`)
- PRC-13 — endpoint do módulo `process` citado pela story (provável listagem de itens do processo para seleção); rota exata fora do recorte deste pacote

## Entidades
- `PriceResearch` — cabeçalho tipado (dono)
- `PriceItem` — item da pesquisa (dono)
- `Document` / `DocumentVersion` — ciclo de vida e numeração (EP-011)
- `ProcessItem` — origem dos itens e da quantidade de referência (EP-001)

## Eventos
- `DocumentCreated` — na criação da pesquisa
- `PriceResearchRecalculated` — a cada mudança relevante no cabeçalho ou nos itens (inclusive a inclusão de itens por `PRS-06`)

## Permissões
- `PRICE_RESEARCH_CREATE` — criar a pesquisa
- `PRICE_RESEARCH_UPDATE` — editar cabeçalho e itens
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver/editar valores em processo sigiloso (POL-09)

## Dependências
- Stories: US-006 (itens canônicos e `ITEM_IN_USE`), US-065 (criação e ciclo de vida do documento), US-110 (template padrão `PRICE_RESEARCH`).
- Decisões: DEC-010, DEC-016, DEC-017, DEC-018, DEC-019, DEC-020, DEC-024, DEC-030, DEC-055, DEC-105, DEC-161; ADR-006.
- Habilitada por esta feature: FT-017 (fontes/cotações referenciam os itens aqui criados).

## Critérios de aceite da feature
```gherkin
Feature: Pesquisa e itens
  Scenario: Criar a pesquisa com os itens do processo
    Given um processo "IN_PROGRESS" com 3 itens não excluídos e sem pesquisa de preços vigente
    When o usuário criar a pesquisa de preços mantendo todos os itens sugeridos
    Then a pesquisa deve nascer com os 3 "PriceItem", o snapshot dos parâmetros do tenant e o documento no template padrão "PRICE_RESEARCH"
```

## Métricas de sucesso
- 100% das pesquisas criadas preservam o snapshot dos parâmetros vigentes na data da criação, mesmo após mudança posterior na configuração do tenant.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Parâmetros alterados pelo administrador durante pesquisas em andamento gerarem resultados divergentes entre pesquisas do mesmo período | Média | Baixo | Snapshot dos parâmetros na criação (DEC-020, inclusive `roundingMode`); novos valores valem só para novas pesquisas |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
